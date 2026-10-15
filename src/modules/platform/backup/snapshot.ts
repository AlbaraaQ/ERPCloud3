/**
 * Logical snapshot engine (BACKUP_AND_RECOVERY §3, D-014).
 *
 * Why a logical format exists at all: the production path is `pg_dump
 * --format=custom`, but a deployment host may not have the client binaries —
 * and then "the backup job ran" must still mean "we hold a restorable copy".
 * This module produces a self-describing snapshot (DDL + data + checksums) that
 * any Postgres can replay, and the restore drill proves it by restoring it into
 * an isolated schema and running the invariant pack.
 *
 * Design notes:
 *  - data is read in ctid-ordered chunks so memory stays bounded on large tables;
 *  - numeric/real columns are transported **as text** (`jsonb_build_object` on the
 *    text cast) and re-parsed by the target column type on restore, so no value
 *    is silently rounded by a JavaScript number in between;
 *  - the snapshot is verified on read (per-table row count + content hash), which
 *    is what makes a checksum meaningful: the hash covers the values, not a byte
 *    range that a bad reader could reproduce.
 */

import { sql } from "drizzle-orm";
import { db } from "@/db";
import { sha256Hex } from "@/modules/shared/crypto";
import { logger } from "@/modules/shared/logger";

/** Executor: the pool or a transaction handle (both support `execute`). */
type Exec = { execute: (query: ReturnType<typeof sql>) => Promise<unknown> };

export interface SnapshotColumn {
  name: string;
  type: string;
  notNull: boolean;
  default: string | null;
  /** transported as text to preserve exact precision */
  asText: boolean;
}

export interface SnapshotTable {
  name: string;
  columns: SnapshotColumn[];
  rows: number;
  sha256: string;
  chunks: number;
  /** constraint DDL, applied AFTER the data load (FK-safe restore) */
  constraints: { name: string; def: string }[];
  indexes: string[];
}

export interface SnapshotManifest {
  version: 1;
  format: "logical-json";
  database: string;
  engineVersion: string;
  generatedAt: string;
  /** `create type` statements for the public schema */
  enums: { name: string; ddl: string }[];
  tables: SnapshotTable[];
  sequences: { name: string; lastValue: string | null }[];
  /** tables deliberately excluded from the capture */
  skipped: string[];
  rowCount: number;
}

export interface SnapshotFile {
  manifest: SnapshotManifest;
  /** table name → ordered row chunks (each chunk is a JSON array of objects) */
  data: Record<string, unknown[][]>;
}

const CHUNK_ROWS = 2_000;
/** pg-boss owns its own schema; capturing it would be noise, not recovery data. */
const EXCLUDED_PREFIXES = ["pgboss"];

function isExcluded(table: string): boolean {
  return EXCLUDED_PREFIXES.some((p) => table.startsWith(p));
}

function asTextType(type: string): boolean {
  return /^(numeric|double precision|real|money)/i.test(type);
}

async function rows<T>(exec: Exec, query: ReturnType<typeof sql>): Promise<T[]> {
  const res = (await exec.execute(query)) as unknown as { rows: T[] };
  return res.rows;
}

/* ------------------------------------------------------------------ capture */

async function captureEnums(): Promise<{ name: string; ddl: string }[]> {
  const found = await rows<{ name: string; labels: string }>(
    db,
    sql`select t.typname as name,
               string_agg(quote_literal(e.enumlabel), ', ' order by e.enumsortorder) as labels
          from pg_type t
          join pg_enum e on e.enumtypid = t.oid
          join pg_namespace n on n.oid = t.typnamespace
         where n.nspname = 'public'
         group by t.typname
         order by t.typname`,
  );
  return found.map((r) => ({ name: r.name, ddl: `create type public."${r.name}" as enum (${r.labels})` }));
}

async function captureSequences(): Promise<{ name: string; lastValue: string | null }[]> {
  const found = await rows<{ name: string; last_value: string | null }>(
    db,
    sql`select c.relname as name, s.last_value::text as last_value
          from pg_class c
          join pg_namespace n on n.oid = c.relnamespace
          left join pg_sequences s on s.schemaname = n.nspname and s.sequencename = c.relname
         where n.nspname = 'public' and c.relkind = 'S'
         order by c.relname`,
  );
  return found.map((r) => ({ name: r.name, lastValue: r.last_value }));
}

async function listTables(): Promise<string[]> {
  const found = await rows<{ table_name: string }>(
    db,
    sql`select c.relname as table_name
          from pg_class c
          join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relkind = 'r'
         order by c.relname`,
  );
  return found.map((r) => r.table_name).filter((t) => !isExcluded(t));
}

async function captureColumns(table: string): Promise<SnapshotColumn[]> {
  const found = await rows<{
    name: string;
    type: string;
    not_null: boolean;
    default_expr: string | null;
  }>(
    db,
    sql`select a.attname as name,
               format_type(a.atttypid, a.atttypmod) as type,
               a.attnotnull as not_null,
               pg_get_expr(ad.adbin, ad.adrelid) as default_expr
          from pg_attribute a
          join pg_class c on c.oid = a.attrelid
          join pg_namespace n on n.oid = c.relnamespace
          left join pg_attrdef ad on ad.adrelid = c.oid and ad.adnum = a.attnum
         where n.nspname = 'public' and c.relname = ${table}
           and a.attnum > 0 and not a.attisdropped
         order by a.attnum`,
  );
  return found.map((c) => ({
    name: c.name,
    type: c.type,
    notNull: Boolean(c.not_null),
    default: c.default_expr,
    asText: asTextType(c.type),
  }));
}

async function captureConstraints(table: string): Promise<{ name: string; def: string }[]> {
  const found = await rows<{ conname: string; def: string }>(
    db,
    sql`select con.conname, pg_get_constraintdef(con.oid) as def
          from pg_constraint con
          join pg_class c on c.oid = con.conrelid
          join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relname = ${table}
         order by con.contype, con.conname`,
  );
  return found.map((r) => ({ name: r.conname, def: r.def }));
}

/**
 * Indexes are captured *without* constraint-backed ones (their constraint DDL
 * recreates them). `where not exists (...)` keeps the two lists disjoint — an
 * index created twice would abort the restore.
 */
async function captureIndexes(table: string): Promise<string[]> {
  const found = await rows<{ indexdef: string }>(
    db,
    sql`select i.indexdef
          from pg_indexes i
         where i.schemaname = 'public' and i.tablename = ${table}
           and not exists (
             select 1 from pg_constraint con
              join pg_class c on c.oid = con.conrelid
             where con.conname = i.indexname and c.relname = i.tablename
           )
         order by i.indexname`,
  );
  return found.map((r) => r.indexdef);
}

function jsonObjectExpression(columns: SnapshotColumn[], alias = ""): string {
  const prefix = alias ? `${alias}.` : "";
  const pairs = columns
    .map((c) => {
      const col = `${prefix}"${c.name}"`;
      const value = c.asText ? `to_jsonb((${col})::text)` : `to_jsonb(${col})`;
      return `'${c.name.replace(/'/g, "''")}', ${value}`;
    })
    .join(", ");
  return `jsonb_build_object(${pairs})`;
}

/** Read one table in ctid-ordered chunks; returns the chunks and their hash. */
async function captureTableData(
  table: string,
  columns: SnapshotColumn[],
): Promise<{ chunks: unknown[][]; rows: number; sha256: string }> {
  const chunks: unknown[][] = [];
  const hashes: string[] = [];
  let captured = 0;
  let cursor = "(0,0)"; // tid literals are (block,tuple)

  for (;;) {
    const expr = jsonObjectExpression(columns);
    const res = await rows<{ payload: unknown[] | null; n: number; last_ct: string | null }>(
      db,
      sql.raw(
        `select jsonb_agg(j order by ct) as payload,
                count(*)::int as n,
                max(ct) as last_ct
           from (
             select ${expr} as j, ctid::text as ct
               from public."${table}"
              where ctid > '${cursor}'::tid
              order by ctid
              limit ${CHUNK_ROWS}
           ) s`,
      ),
    );
    const payload = res[0]?.payload ?? [];
    const n = Number(res[0]?.n ?? 0);
    if (n === 0) break;
    chunks.push(payload as unknown[]);
    hashes.push(sha256Hex(JSON.stringify(payload)));
    captured += n;
    cursor = res[0]!.last_ct ?? cursor;
    if (n < CHUNK_ROWS) break;
  }

  return { chunks, rows: captured, sha256: sha256Hex(hashes.join(":")) };
}

/**
 * Build the logical snapshot. Tables are captured independently; a table that
 * cannot be read (permissions, a view we mis-classified) aborts the capture —
 * a partial backup presented as complete is worse than no backup.
 */
export async function buildSnapshot(opts: { databaseName: string }): Promise<SnapshotFile> {
  const started = Date.now();
  const tables = await listTables();
  const enums = await captureEnums();
  const sequences = await captureSequences();
  const versionRows = await rows<{ v: string }>(db, sql`select version() as v`);

  const data: Record<string, unknown[][]> = {};
  const manifestTables: SnapshotTable[] = [];
  let rowCount = 0;

  for (const table of tables) {
    const columns = await captureColumns(table);
    const captured = await captureTableData(table, columns);
    const constraints = await captureConstraints(table);
    const indexes = await captureIndexes(table);

    data[table] = captured.chunks;
    rowCount += captured.rows;
    manifestTables.push({
      name: table,
      columns,
      rows: captured.rows,
      sha256: captured.sha256,
      chunks: captured.chunks.length,
      constraints,
      indexes,
    });
  }

  const manifest: SnapshotManifest = {
    version: 1,
    format: "logical-json",
    database: opts.databaseName,
    engineVersion: String(versionRows[0]?.v ?? "unknown").slice(0, 120),
    generatedAt: new Date().toISOString(),
    enums,
    tables: manifestTables,
    sequences,
    skipped: EXCLUDED_PREFIXES.map((p) => `${p}*`),
    rowCount,
  };

  logger.info(
    { tables: manifestTables.length, rows: rowCount, ms: Date.now() - started },
    "snapshot captured",
  );
  return { manifest, data };
}

/* ----------------------------------------------------------------- restore */

/**
 * DDL for one table, minus constraints (applied after the data load so foreign
 * keys cannot be violated by insertion order). `targetSchema` replaces `public`
 * so a drill can never touch the live schema.
 */
function tableDdl(table: SnapshotTable, targetSchema: string): string {
  const columns = table.columns
    .map((c) => {
      const parts = [`"${c.name}" ${c.type}`];
      if (c.default) parts.push(`default ${c.default}`);
      if (c.notNull) parts.push("not null");
      return parts.join(" ");
    })
    .join(", ");
  return `create table "${targetSchema}"."${table.name}" (${columns})`;
}

/** `create unique index name on t (...)` → `create unique index on t (...)` */
export function stripIndexName(ddl: string): string {
  return ddl.replace(/^\s*create\s+(unique\s+)?index\s+"?[^"\s]+"?\s+on\s+/i, (match, unique: string | undefined) =>
    `create ${unique ?? ""}index on `,
  );
}

function retargetSchema(ddl: string, targetSchema: string): string {
  return ddl
    .replace(/\bpublic\./g, `"${targetSchema}".`)
    .replace(/ALTER TABLE ONLY public\./gi, `ALTER TABLE ONLY "${targetSchema}".`);
}

export interface RestoreResult {
  targetSchema: string;
  tables: number;
  rows: number;
  durationMs: number;
}

/**
 * Restore a snapshot into `targetSchema` inside the current database.
 *
 * Order: schema → enums (referenced types are recreated when they are not part
 * of the target DB — in the drill the public enums already exist, so this is
 * `if not exists`-safe) → tables → data → constraints → indexes.
 */
export async function restoreSnapshot(
  file: SnapshotFile,
  opts: { targetSchema: string; createSchema?: boolean; exec?: Exec },
): Promise<RestoreResult> {
  const started = Date.now();
  const exec = opts.exec ?? db;
  const target = opts.targetSchema;
  if (!/^[a-z0-9_]+$/.test(target)) throw new Error(`unsafe target schema: ${target}`);

  if (opts.createSchema !== false) {
    await exec.execute(sql.raw(`create schema if not exists "${target}"`));
  }

  for (const en of file.manifest.enums) {
    // the drill restores into the same database, where the enum already exists
    await exec.execute(sql.raw(en.ddl)).catch(() => undefined);
  }

  for (const table of file.manifest.tables) {
    await exec.execute(sql.raw(tableDdl(table, target)));
  }

  let rowsRestored = 0;
  for (const table of file.manifest.tables) {
    const columnList = table.columns.map((c) => `"${c.name}"`).join(", ");
    for (const chunk of file.data[table.name] ?? []) {
      if (chunk.length === 0) continue;
      // jsonb_populate_recordset casts text back into the real column types,
      // so numerics keep their exact value (no floating-point round trip).
      await exec.execute(sql`
        insert into ${sql.raw(`"${target}"."${table.name}"`)} (${sql.raw(columnList)})
        select ${sql.raw(columnList)}
          from jsonb_populate_recordset(null::public."${sql.raw(table.name)}", ${JSON.stringify(chunk)}::jsonb)
      `);
      rowsRestored += chunk.length;
    }
  }

  for (const table of file.manifest.tables) {
    for (const con of table.constraints) {
      const def = retargetSchema(con.def, target);
      await exec.execute(
        sql.raw(`alter table "${target}"."${table.name}" add constraint "${con.name}" ${def}`),
      );
    }
  }

  for (const table of file.manifest.tables) {
    for (const indexDef of table.indexes) {
      // The index NAME is dropped (`create index on t (...)`) so Postgres derives a
      // fresh one: index names live in the schema namespace, and mangling them to
      // fit 63 bytes silently produced collisions.
      const def = stripIndexName(retargetSchema(indexDef, target));
      await exec.execute(sql.raw(def)).catch((e: unknown) => {
        logger.warn({ err: e, table: table.name, index: indexDef.slice(0, 80) }, "index restore skipped");
      });
    }
  }

  return {
    targetSchema: target,
    tables: file.manifest.tables.length,
    rows: rowsRestored,
    durationMs: Date.now() - started,
  };
}

/* -------------------------------------------------------------- verification */

export interface SnapshotVerification {
  ok: boolean;
  tables: number;
  rows: number;
  manifestRowCount: number;
  problems: string[];
}

/**
 * Verify a snapshot against its own manifest: every table present, every chunk
 * count as recorded, the content hash reproduced from the rows, and the total
 * row count consistent. This runs on the *artifact contents*, so a truncated or
 * edited file fails here even if its wrapper checksum was recomputed.
 */
export function verifySnapshot(file: SnapshotFile): SnapshotVerification {
  const problems: string[] = [];
  let tables = 0;
  let rowCount = 0;

  for (const table of file.manifest.tables) {
    const chunks = file.data[table.name];
    if (!chunks) {
      problems.push(`${table.name}: no data in artifact`);
      continue;
    }
    if (chunks.length !== table.chunks) {
      problems.push(`${table.name}: chunk count ${chunks.length} ≠ manifest ${table.chunks}`);
    }
    const written = chunks.reduce((sum, c) => sum + c.length, 0);
    if (written !== table.rows) {
      problems.push(`${table.name}: row count ${written} ≠ manifest ${table.rows}`);
    }
    const hash = sha256Hex(chunks.map((c) => sha256Hex(JSON.stringify(c))).join(":"));
    if (hash !== table.sha256) problems.push(`${table.name}: content hash mismatch`);
    tables += 1;
    rowCount += written;
  }

  if (rowCount !== file.manifest.rowCount) {
    problems.push(`total rows ${rowCount} ≠ manifest ${file.manifest.rowCount}`);
  }

  return { ok: problems.length === 0, tables, rows: rowCount, manifestRowCount: file.manifest.rowCount, problems };
}

/** Parse a snapshot payload (JSON text) with a shape check before use. */
export function parseSnapshot(text: string | Buffer): SnapshotFile {
  const parsed = JSON.parse(text.toString("utf8")) as SnapshotFile;
  if (!parsed?.manifest || parsed.manifest.version !== 1 || !parsed.data) {
    throw new Error("not a Hisab backup snapshot (missing manifest/version)");
  }
  return parsed;
}
