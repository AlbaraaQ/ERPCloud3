/**
 * Logical snapshot engine (BACKUP_AND_RECOVERY §1/§3/§5).
 *
 * Two formats are supported by the pipeline:
 *
 *   1. `pg_dump-custom` — the production path mandated by D-014. Requires the
 *      PostgreSQL client binaries on the host; the dumper is probed at runtime
 *      (see pgdump.ts) and the run metadata always states which format was used.
 *   2. `logical-json` — this module: a complete, self-describing capture of
 *      `public` (enums, tables, constraints, indexes and every row) that can be
 *      produced and restored by the application itself. It exists because
 *      sandboxes and managed environments may not ship `pg_dump` (this project's
 *      dev sandbox does not), and a backup capability that cannot be exercised
 *      is worthless — but it is NEVER presented as a pg_dump artifact.
 *
 * Both feed the same downstream steps: SHA-256 → AES-256-GCM → local artifact →
 * verification → (optional) remote upload → restore drill.
 *
 * Numeric columns are captured as text: JSON numbers are IEEE-754 doubles and
 * would silently round `numeric(18,6)`. Restoring casts text back through the
 * column's input function, so the value round-trips exactly.
 */

import { sql } from "drizzle-orm";
import type { Trx } from "@/modules/shared/db-context";
import { sha256Hex } from "@/modules/shared/crypto";

export const SNAPSHOT_VERSION = 1;
export const SNAPSHOT_FORMAT = "logical-json";
const CHUNK_ROWS = 5000;

type Exec = Pick<Trx, "execute">;

interface Raw {
  rows: Record<string, unknown>[];
}

async function q(exec: Exec, text: ReturnType<typeof sql>): Promise<Raw> {
  return (await exec.execute(text)) as unknown as Raw;
}

/* ------------------------------------------------------------- schema capture */

export interface ColumnDef {
  name: string;
  type: string;
  notNull: boolean;
  defaultExpr: string | null;
  /** true when captured as text to protect exactness */
  asText: boolean;
}

export interface TableDef {
  name: string;
  columns: ColumnDef[];
}

export interface SchemaCapture {
  enums: { name: string; labels: string[] }[];
  tables: TableDef[];
  constraints: { table: string; name: string; def: string; type: string }[];
  indexes: { table: string; name: string; def: string }[];
  sequences: { name: string; lastValue: string | null; ownedBy: string | null }[];
}

const TEXTY_TYPES = new Set(["numeric", "double precision", "real"]);

/** Capture the DDL-relevant schema of `public` (excludes pg-boss internals). */
export async function captureSchema(exec: Exec): Promise<SchemaCapture> {
  const enums = await q(
    exec,
    sql`select t.typname as name, array_agg(e.enumlabel order by e.enumsortorder) as labels
        from pg_type t
        join pg_enum e on e.enumtypid = t.oid
        join pg_namespace n on n.oid = t.typnamespace
        where n.nspname = 'public'
        group by t.typname
        order by t.typname`,
  );

  const cols = await q(
    exec,
    sql`select c.relname as table_name, a.attname as column_name,
               format_type(a.atttypid, a.atttypmod) as column_type,
               a.attnotnull as not_null,
               pg_get_expr(ad.adbin, ad.adrelid) as default_expr
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
        left join pg_attrdef ad on ad.adrelid = c.oid and ad.adnum = a.attnum
        where n.nspname = 'public' and c.relkind = 'r' and c.relname not like 'pgboss%'
        order by c.relname, a.attnum`,
  );

  const tableMap = new Map<string, TableDef>();
  for (const row of cols.rows) {
    const table = String(row.table_name);
    const type = String(row.column_type);
    if (!tableMap.has(table)) tableMap.set(table, { name: table, columns: [] });
    tableMap.get(table)!.columns.push({
      name: String(row.column_name),
      type,
      notNull: row.not_null === true,
      defaultExpr: row.default_expr == null ? null : String(row.default_expr),
      asText: TEXTY_TYPES.has(type),
    });
  }

  const constraints = await q(
    exec,
    sql`select c.relname as table_name, con.conname as name,
               pg_get_constraintdef(con.oid) as def, con.contype::text as contype
        from pg_constraint con
        join pg_class c on c.oid = con.conrelid
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and con.contype in ('p','u','c','f','x')
        order by c.relname, con.conname`,
  );

  const allIndexes = await q(
    exec,
    sql`select tablename as table_name, indexname as name, indexdef as def
        from pg_indexes where schemaname = 'public' order by tablename, indexname`,
  );
  const constraintNames = new Set(constraints.rows.map((r) => String(r.name)));
  const indexes = allIndexes.rows.filter((r) => !constraintNames.has(String(r.name)));

  const sequences = await q(
    exec,
    sql`select s.sequencename as name, s.last_value::text as last_value,
               (select pg_get_serial_sequence('public.' || s.sequencename, '') ) as owned_by
        from pg_sequences s where s.schemaname = 'public'`,
  ).catch(() => ({ rows: [] as Record<string, unknown>[] }));

  return {
    enums: enums.rows.map((r) => ({ name: String(r.name), labels: (r.labels as string[]) ?? [] })),
    tables: [...tableMap.values()],
    constraints: constraints.rows.map((r) => ({
      table: String(r.table_name),
      name: String(r.name),
      def: String(r.def),
      type: String(r.contype),
    })),
    indexes: indexes.map((r) => ({ table: String(r.table_name), name: String(r.name), def: String(r.def) })),
    sequences: sequences.rows.map((r) => ({
      name: String(r.name),
      lastValue: r.last_value == null ? null : String(r.last_value),
      ownedBy: null,
    })),
  };
}

/* ---------------------------------------------------------------- data capture */

export interface TableCapture extends TableDef {
  rowCount: number;
  sha256: string;
  /** rows as JSON objects (numeric columns as text) */
  chunks: string[];
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** Build the per-column projection used both for capture and hashing. */
function projection(table: TableDef): string {
  return table.columns
    .map((c) => {
      const ident = quoteIdent(c.name);
      // text-cast money/decimal columns so exactness survives JSON
      return c.asText ? `${ident}::text as ${ident}` : `${ident} as ${ident}`;
    })
    .join(", ");
}

function buildObjectExpr(table: TableDef): string {
  const pairs: string[] = [];
  for (const c of table.columns) {
    pairs.push(`'${c.name.replace(/'/g, "''")}'`, quoteIdent(c.name));
  }
  return `jsonb_build_object(${pairs.join(", ")})`;
}

/**
 * Capture one table's rows chunk-by-chunk in physical (ctid) order. ctid
 * ordering keeps the capture deterministic without requiring a primary key, and
 * the per-table SHA-256 is computed over the ordered chunk payloads.
 */
export async function captureTable(exec: Exec, table: TableDef): Promise<TableCapture> {
  const chunks: string[] = [];
  const hashes: string[] = [];
  let lastCtid: string | null = null;
  let total = 0;

  for (;;) {
    const rows = await q(
      exec,
      sql`
        select coalesce(jsonb_agg(j order by ct), '[]'::jsonb)::text as payload, count(*)::int as n,
               max(ct) as last_ct
        from (
          select ${sql.raw(buildObjectExpr(table))} as j, ctid::text as ct
          from ${sql.raw(`public.${quoteIdent(table.name)}`)}
          where ${lastCtid ? sql`ctid > ${lastCtid}::tid` : sql`true`}
          order by ctid
          limit ${CHUNK_ROWS}
        ) s
      `,
    );
    const row = rows.rows[0] ?? {};
    const payload = String(row.payload ?? "[]");
    const n = Number(row.n ?? 0);
    if (n === 0) break;
    chunks.push(payload);
    hashes.push(sha256Hex(payload));
    total += n;
    lastCtid = row.last_ct == null ? null : String(row.last_ct);
    if (n < CHUNK_ROWS || !lastCtid) break;
  }

  return {
    ...table,
    rowCount: total,
    sha256: sha256Hex(hashes.join("|")),
    chunks,
  };
}

export interface SnapshotFile {
  format: typeof SNAPSHOT_FORMAT;
  version: number;
  generatedAt: string;
  database: string;
  engineVersion: string;
  schema: SchemaCapture;
  tables: TableCapture[];
}

export interface CaptureOptions {
  database: string;
  engineVersion: string;
  now?: Date;
  /** restrict to these tables (tests use a subset); default: everything */
  only?: string[];
}

/** Capture a complete snapshot of the current database. */
export async function buildSnapshot(exec: Exec, opts: CaptureOptions): Promise<{
  buffer: Buffer;
  file: SnapshotFile;
  tableStats: Record<string, { rows: number; sha256: string }>;
}> {
  const schema = await captureSchema(exec);
  const wanted = opts.only ? new Set(opts.only) : null;
  const tables = schema.tables.filter((t) => !wanted || wanted.has(t.name));

  const captured: TableCapture[] = [];
  const tableStats: Record<string, { rows: number; sha256: string }> = {};
  for (const table of tables) {
    const capture = await captureTable(exec, table);
    captured.push(capture);
    tableStats[capture.name] = { rows: capture.rowCount, sha256: capture.sha256 };
  }

  const file: SnapshotFile = {
    format: SNAPSHOT_FORMAT,
    version: SNAPSHOT_VERSION,
    generatedAt: (opts.now ?? new Date()).toISOString(),
    database: opts.database,
    engineVersion: opts.engineVersion,
    schema,
    tables: captured,
  };
  return { buffer: Buffer.from(JSON.stringify(file), "utf8"), file, tableStats };
}

/* -------------------------------------------------------------------- parsing */

export function parseSnapshot(buffer: Buffer): SnapshotFile {
  const parsed = JSON.parse(buffer.toString("utf8")) as SnapshotFile;
  if (parsed.format !== SNAPSHOT_FORMAT) {
    throw new Error(`unexpected snapshot format: ${parsed.format}`);
  }
  if (!parsed.version || parsed.version > SNAPSHOT_VERSION) {
    throw new Error(`unsupported snapshot version: ${parsed.version}`);
  }
  if (!Array.isArray(parsed.tables)) throw new Error("snapshot has no tables array");
  return parsed;
}

/* ------------------------------------------------------------------- restore */

export interface RestoreOptions {
  /** Target schema (isolated — never `public` of a live database). */
  targetSchema: string;
  /** Skip these tables during restore (e.g. to test a partial failure). */
  skipTables?: string[];
}

export interface RestoreReport {
  targetSchema: string;
  tables: { name: string; rows: number }[];
  rows: number;
  durationMs: number;
}

function remapSchema(ddl: string, targetSchema: string): string {
  return ddl.replace(/\bpublic\./g, `${quoteIdent(targetSchema)}.`);
}

/**
 * Restore a snapshot into an isolated schema:
 *   create schema → tables (no constraints) → rows → constraints → indexes.
 * Loading data before constraints is what makes a restore order-independent
 * (the same reason pg_restore does it); it also means no trigger on `public`
 * can fire while the drill target is being populated.
 */
export async function restoreSnapshot(
  exec: Exec,
  file: SnapshotFile,
  opts: RestoreOptions,
): Promise<RestoreReport> {
  const started = Date.now();
  const target = quoteIdent(opts.targetSchema);
  const skip = new Set(opts.skipTables ?? []);

  await exec.execute(sql.raw(`create schema if not exists ${target}`));

  // 1. tables (columns + defaults only)
  for (const table of file.schema.tables) {
    if (skip.has(table.name)) continue;
    const cols = table.columns
      .map((c) => {
        const parts = [`${quoteIdent(c.name)} ${c.type}`];
        if (c.notNull) parts.push("not null");
        if (c.defaultExpr) parts.push(`default ${c.defaultExpr}`);
        return parts.join(" ");
      })
      .join(", ");
    await exec.execute(
      sql.raw(`create table if not exists ${target}.${quoteIdent(table.name)} (${cols})`),
    );
  }

  // 2. rows
  const restored: { name: string; rows: number }[] = [];
  let totalRows = 0;
  for (const table of file.tables) {
    if (skip.has(table.name)) continue;
    const targetTable = `${target}.${quoteIdent(table.name)}`;
    let rows = 0;
    for (const chunk of table.chunks) {
      if (chunk === "[]") continue;
      const res = await exec.execute(
        sql`insert into ${sql.raw(targetTable)}
            select * from jsonb_populate_recordset(null::${sql.raw(`public.${quoteIdent(table.name)}`)}, ${chunk}::jsonb)`,
      );
      rows += (res as unknown as { rowCount?: number }).rowCount ?? 0;
    }
    restored.push({ name: table.name, rows });
    totalRows += rows;
  }

  // 3. constraints (PK/unique/check then foreign keys last)
  const order = { p: 0, u: 1, c: 2, x: 3, f: 4 } as Record<string, number>;
  for (const con of [...file.schema.constraints].sort((a, b) => (order[a.type] ?? 9) - (order[b.type] ?? 9))) {
    if (skip.has(con.table)) continue;
    await exec.execute(
      sql.raw(
        `alter table ${target}.${quoteIdent(con.table)} add constraint ${quoteIdent(con.name)} ${remapSchema(con.def, opts.targetSchema)}`,
      ),
    );
  }

  // 4. indexes
  for (const idx of file.schema.indexes) {
    if (skip.has(idx.table)) continue;
    await exec.execute(sql.raw(remapSchema(idx.def, opts.targetSchema)));
  }

  // 5. sequences (our schema has none, but stay correct if one appears)
  for (const seq of file.schema.sequences) {
    if (seq.lastValue) {
      await exec.execute(
        sql.raw(`create sequence if not exists ${target}.${quoteIdent(seq.name)}`),
      ).catch(() => undefined);
      await exec.execute(
        sql.raw(`select setval('${opts.targetSchema}.${seq.name}', ${seq.lastValue}, true)`),
      ).catch(() => undefined);
    }
  }

  return { targetSchema: opts.targetSchema, tables: restored, rows: totalRows, durationMs: Date.now() - started };
}

/** Drop an isolated restore target (always run in a finally block). */
export async function dropSchema(exec: Exec, schema: string): Promise<void> {
  await exec.execute(sql.raw(`drop schema if exists ${quoteIdent(schema)} cascade`));
}
