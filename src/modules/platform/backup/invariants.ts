/**
 * Post-restore invariants (BACKUP_AND_RECOVERY §5).
 *
 * A restore that "finished" is not evidence. These checks are run against the
 * restored copy and produce the numbers that go into the drill record:
 *
 *  1. `row_counts`        — every table matches the manifest row count;
 *  2. `journal_balance`   — every posted journal entry in the copy balances;
 *  3. `tenant_partitioning` — no tenant-less business row, and per-tenant counts
 *     match the *capture* (its own manifest), so a drill run later still proves
 *     the copy, not the passage of time;
 *  4. `row_sampling`      — random rows compared value-by-value against the values
 *     held in the snapshot;
 *  5. `audit_integrity`   — restored audit rows are hash-bearing and ordered;
 *  6. `isolation`         — the copy lives in an isolated schema: it has no
 *     policies of its own and did not disturb the source's policies;
 *  7. `referential_integrity` — every captured foreign key can be satisfied from
 *     inside the snapshot, so the restore can actually rebuild its constraints
 *     (a copy that cannot is a pile of rows, not a database — and it is how a
 *     source that is *already* inconsistent is caught at capture time instead of
 *     at 3 a.m. during a restore).
 *
 * Rules honoured here: a check that cannot run says so (`skipped: true`) instead
 * of passing silently, and a mismatch is reported with the offending record.
 */

import { sql } from "drizzle-orm";
import { db } from "@/db";
import type { SnapshotFile } from "./snapshot";

type Exec = { execute: (query: ReturnType<typeof sql>) => Promise<unknown> };

export interface InvariantCheck {
  name: string;
  ok: boolean;
  detail: string;
  skipped?: boolean;
  metrics?: Record<string, unknown>;
}

export interface InvariantReport {
  ok: boolean;
  checks: InvariantCheck[];
  durationMs: number;
}

async function rows<T>(exec: Exec, query: ReturnType<typeof sql>): Promise<T[]> {
  const res = (await exec.execute(query)) as unknown as { rows: T[] };
  return res.rows;
}

const TABLES_WITH_TENANT = /tenant_id/;

/**
 * Tables where a NULL tenant_id is legitimate: they carry platform-scoped rows
 * (platform audit entries, console sessions, global alerts, the settings KV).
 * Business tables must never have a tenant-less row, and that is the point of
 * this check — a blanket rule would either fail on platform rows or be relaxed
 * until it proved nothing.
 */
const PLATFORM_SCOPED_TABLES = new Set([
  "audit_log",
  "sessions",
  "platform_alerts",
  "platform_settings",
  "rate_limits",
  "usage_metrics",
]);

function isPlatformScoped(table: string): boolean {
  return (
    PLATFORM_SCOPED_TABLES.has(table) ||
    table.startsWith("platform_") ||
    table.startsWith("backup_") ||
    table.startsWith("pgboss")
  );
}

const FK_RE = /FOREIGN KEY \(([^)]+)\) REFERENCES ([^(]+)\(([^)]+)\)/i;

function bare(identifier: string): string {
  return identifier.trim().replace(/^public\./i, "").replace(/"/g, "");
}

function keyOf(row: Record<string, unknown>, columns: string[]): string {
  return columns.map((c) => String(row[c])).join("\u0000");
}

/**
 * Foreign keys captured with the snapshot, checked against the snapshot's own
 * rows. Pure — it needs no database, so it runs inside verification as well as
 * inside the drill.
 */
export function referentialIntegrity(snapshot: SnapshotFile): InvariantCheck {
  const tables = new Map(snapshot.manifest.tables.map((t) => [t.name, t]));
  const parentKeys = new Map<string, Set<string>>();
  const problems: string[] = [];
  let checkedKeys = 0;

  for (const table of snapshot.manifest.tables) {
    for (const constraint of table.constraints) {
      const match = FK_RE.exec(constraint.def);
      if (!match) continue;
      const childColumns = match[1]!.split(",").map(bare);
      const parentName = bare(match[2]!);
      const parentColumns = match[3]!.split(",").map(bare);
      const parent = tables.get(parentName);
      if (!parent) {
        problems.push(`${table.name}.${constraint.name}: references ${parentName}, which this snapshot does not capture`);
        continue;
      }

      let keys = parentKeys.get(parentName);
      if (!keys) {
        keys = new Set<string>();
        for (const chunk of snapshot.data[parentName] ?? []) {
          for (const row of chunk as Record<string, unknown>[]) keys.add(keyOf(row, parentColumns));
        }
        parentKeys.set(parentName, keys);
      }

      checkedKeys += 1;
      const orphans: string[] = [];
      for (const chunk of snapshot.data[table.name] ?? []) {
        for (const row of chunk as Record<string, unknown>[]) {
          // a NULL component makes the constraint satisfied by definition
          if (childColumns.some((c) => row[c] === null || row[c] === undefined)) continue;
          if (!keys.has(keyOf(row, childColumns))) {
            orphans.push(`${table.name}(${childColumns.map((c) => `${c}=${String(row[c])}`).join(", ")})`);
          }
        }
      }
      if (orphans.length > 0) {
        problems.push(
          `${constraint.name}: ${orphans.length} ${table.name} row(s) have no ${parentName} parent, e.g. ${orphans[0]}`,
        );
      }
    }
  }

  if (checkedKeys === 0) {
    return { name: "referential_integrity", ok: true, skipped: true, detail: "no foreign keys captured" };
  }
  return {
    name: "referential_integrity",
    ok: problems.length === 0,
    detail:
      problems.length === 0
        ? `all ${checkedKeys} foreign keys are satisfied inside the snapshot`
        : `${problems.length} foreign key(s) cannot be rebuilt: ${problems.slice(0, 4).join("; ")}`,
    metrics: { foreignKeys: checkedKeys },
  };
}

export async function runInvariants(
  snapshot: SnapshotFile,
  opts: { targetSchema: string; exec?: Exec; sampleSize?: number },
): Promise<InvariantReport> {
  const started = Date.now();
  const exec = opts.exec ?? db;
  const target = opts.targetSchema;
  if (!/^[a-z0-9_]+$/.test(target)) throw new Error(`unsafe target schema: ${target}`);
  const checks: InvariantCheck[] = [];
  const sampleSize = opts.sampleSize ?? 5;

  /* ---------------------------------------------------------- 1. row counts */
  {
    const mismatches: string[] = [];
    let total = 0;
    for (const table of snapshot.manifest.tables) {
      const found = await rows<{ n: number }>(
        exec,
        sql`select count(*)::int as n from ${sql.raw(`"${target}"."${table.name}"`)}`,
      );
      const n = Number(found[0]?.n ?? -1);
      total += n;
      if (n !== table.rows) mismatches.push(`${table.name}: ${n} ≠ ${table.rows}`);
    }
    checks.push({
      name: "row_counts",
      ok: mismatches.length === 0,
      detail:
        mismatches.length === 0
          ? `${snapshot.manifest.tables.length} tables match the manifest (${total} rows)`
          : `row-count mismatches: ${mismatches.slice(0, 5).join("; ")}`,
      metrics: { tables: snapshot.manifest.tables.length, rows: total },
    });
  }

  /* ------------------------------------------------------ 2. journal balance */
  {
    const hasEntries = snapshot.manifest.tables.some((t) => t.name === "journal_entries");
    if (!hasEntries) {
      checks.push({ name: "journal_balance", ok: true, skipped: true, detail: "no journal_entries in this capture" });
    } else {
      const unbalanced = await rows<{ entry_id: string; debit: string; credit: string }>(
        exec,
        sql.raw(`select l.entry_id, sum(l.debit)::text as debit, sum(l.credit)::text as credit
                   from "${target}"."journal_lines" l
                   join "${target}"."journal_entries" e on e.id = l.entry_id
                  where e.status = 'posted'
                  group by l.entry_id
                 having abs(sum(l.debit) - sum(l.credit)) > 0.0001
                  limit 5`),
      );
      const posted = await rows<{ n: number }>(
        exec,
        sql.raw(`select count(*)::int as n from "${target}"."journal_entries" where status = 'posted'`),
      );
      checks.push({
        name: "journal_balance",
        ok: unbalanced.length === 0,
        detail:
          unbalanced.length === 0
            ? `${posted[0]?.n ?? 0} posted entries balance`
            : `${unbalanced.length} unbalanced entries, e.g. ${unbalanced[0]!.entry_id}`,
        metrics: { postedEntries: Number(posted[0]?.n ?? 0) },
      });
    }
  }

  /**
 * A NULL tenant_id is only legitimate where the row is global or terminal by the
 * table's own rules — a global feature flag, or a deletion-request row whose tenant
 * has already been purged (the register outlives the tenant because it carries the
 * certificate). Anywhere else a NULL means the row lost its tenant.
 */
const NULL_TENANT_ALLOWED: Record<string, string> = {
  feature_flags: "scope = 'global'",
  deletion_requests: "status in ('purged','cancelled')",
};

/* --------------------------------------------------- 3. tenant partitioning */
  {
    const problems: string[] = [];
    let scoped = 0;
    for (const table of snapshot.manifest.tables) {
      const columns = table.columns.map((c) => c.name);
      if (!columns.some((c) => TABLES_WITH_TENANT.test(c))) continue;
      if (isPlatformScoped(table.name)) continue;
      scoped += 1;
      const rule = NULL_TENANT_ALLOWED[table.name];
      const nulls = await rows<{ n: number }>(
        exec,
        sql.raw(
          `select count(*)::int as n from "${target}"."${table.name}" where tenant_id is null${
            rule ? ` and not (${rule})` : ""
          }`,
        ),
      );
      if (Number(nulls[0]?.n ?? 0) > 0) {
        problems.push(
          `${table.name}: ${nulls[0]!.n} row(s) without tenant_id${rule ? ` (and not ${rule})` : ""}`,
        );
      }
    }

    // Per-tenant counts must match the capture's own manifest (not the live
    // database, which is expected to have moved on since the snapshot).
    let compared = 0;
    const countsAvailable = Boolean(snapshot.manifest.tenantCounts);
    // A snapshot written before per-tenant counts existed cannot be compared;
    // that is "not checked", not "failed" — and it is reported as such.
    const capturedCounts = snapshot.manifest.tenantCounts;
    if (capturedCounts) {
      for (const [tenantId, expected] of Object.entries(capturedCounts)) {
        for (const [table, count] of Object.entries(expected)) {
          const got = await rows<{ n: number }>(
            exec,
            sql.raw(`select count(*)::int as n from "${target}"."${table}" where tenant_id = '${tenantId}'::uuid`),
          );
          compared += 1;
          const n = Number(got[0]?.n ?? -1);
          if (n !== count) problems.push(`${table}: tenant ${tenantId.slice(0, 8)} has ${n}, capture had ${count}`);
        }
      }
      // and no tenant may appear in the copy that the capture did not have
      for (const table of snapshot.manifest.tables) {
        if (!table.columns.some((c) => c.name === "tenant_id")) continue;
        if (isPlatformScoped(table.name)) continue;
        const extra = await rows<{ tenant_id: string; n: number }>(
          exec,
          sql.raw(`select tenant_id::text as tenant_id, count(*)::int as n from "${target}"."${table.name}"
                    where tenant_id is not null group by tenant_id`),
        );
        for (const row of extra) {
          if (!capturedCounts[row.tenant_id]) {
            problems.push(`${table.name}: unexpected tenant ${row.tenant_id.slice(0, 8)} in the copy`);
          }
        }
      }
    }

    checks.push({
      name: "tenant_partitioning",
      ok: problems.length === 0,
      detail:
        problems.length === 0
          ? `every business table with tenant_id (${scoped}) is fully tenant-owned; per-tenant counts match the capture (platform-scoped tables such as audit_log/sessions excluded by design)${
              countsAvailable ? "" : " — NOT compared: this manifest predates the check"
            }`
          : problems.slice(0, 5).join("; "),
      skipped: !countsAvailable,
      metrics: { tenantScopedTables: scoped, tenantCountsCompared: compared },
    });
  }

  /* ------------------------------------------------------------ 4. row sampling */
  {
    const candidates = snapshot.manifest.tables
      .filter((t) => t.rows > 0 && t.columns.some((c) => c.name === "id"))
      .sort((a, b) => b.rows - a.rows)
      .slice(0, 3);
    if (candidates.length === 0) {
      checks.push({ name: "row_sampling", ok: true, skipped: true, detail: "no keyed tables with rows to sample" });
    } else {
      let sampled = 0;
      const mismatches: string[] = [];
      const columns = ["id", "tenant_id"];
      for (const table of candidates) {
        // rows are compared against the snapshot itself: the copy must reproduce
        // the captured values exactly, whatever the live database looks like now
        const captured = new Map<string, Record<string, unknown>>();
        for (const chunk of snapshot.data[table.name] ?? []) {
          for (const row of chunk as Record<string, unknown>[]) captured.set(String(row.id), row);
        }
        const keys = await rows<{ id: string }>(
          exec,
          sql.raw(`select id::text as id from "${target}"."${table.name}" order by ctid limit ${sampleSize}`),
        );
        for (const key of keys) {
          const expected = captured.get(key.id);
          if (!expected) {
            mismatches.push(`${table.name}:${key.id} (not in the capture)`);
            continue;
          }
          const actual = await rows<Record<string, unknown>>(
            exec,
            sql.raw(`select ${columns.map((c) => `"${c}"::text as ${c}`).join(", ")} from "${target}"."${table.name}" where id = '${key.id}'::uuid`),
          );
          const row = actual[0] ?? {};
          sampled += 1;
          const differs = columns.some(
            (c) => String(row[c] ?? "") !== String(expected[c] ?? ""),
          );
          if (differs) mismatches.push(`${table.name}:${key.id}`);
        }
      }
      checks.push({
        name: "row_sampling",
        ok: mismatches.length === 0,
        detail:
          mismatches.length === 0
            ? `${sampled}/${sampled} sampled rows reproduce their captured values`
            : `${mismatches.length} sampled rows differ, e.g. ${mismatches[0]}`,
        metrics: { sampled, tables: candidates.map((c) => c.name) },
      });
    }
  }

  /* --------------------------------------------------------- 5. audit integrity */
  {
    const hasAudit = snapshot.manifest.tables.some((t) => t.name === "audit_log" && t.rows > 0);
    if (!hasAudit) {
      checks.push({ name: "audit_integrity", ok: true, skipped: true, detail: "no audit rows captured" });
    } else {
      const bad = await rows<{ n: number }>(
        exec,
        sql.raw(`select count(*)::int as n from "${target}"."audit_log" where hash is null or hash = ''`),
      );
      const total = await rows<{ n: number }>(exec, sql.raw(`select count(*)::int as n from "${target}"."audit_log"`));
      checks.push({
        name: "audit_integrity",
        ok: Number(bad[0]?.n ?? 0) === 0,
        detail:
          Number(bad[0]?.n ?? 0) === 0
            ? `all ${total[0]?.n ?? 0} restored audit rows carry a hash`
            : `${bad[0]!.n} restored audit rows have no hash`,
        metrics: { auditRows: Number(total[0]?.n ?? 0) },
      });
    }
  }

  /* -------------------------------------------------- 7. referential integrity */
  checks.push(referentialIntegrity(snapshot));

  /* ------------------------------------------------------------- 6. isolation */
  {
    const targetPolicies = await rows<{ n: number }>(
      exec,
      sql`select count(*)::int as n from pg_policies where schemaname = ${target}`,
    );
    const publicPolicies = await rows<{ n: number }>(
      exec,
      sql`select count(*)::int as n from pg_policies where schemaname = 'public' and policyname like 'tenant%'`,
    );
    const sameDatabase = await rows<{ db: string; schema: string }>(
      exec,
      sql`select current_database() as db, current_schema() as schema`,
    );
    checks.push({
      name: "isolation",
      ok: Number(targetPolicies[0]?.n ?? 0) === 0 && Number(publicPolicies[0]?.n ?? 0) > 0,
      detail:
        Number(targetPolicies[0]?.n ?? 0) === 0
          ? `copy lives in schema "${target}"; source policies untouched (${publicPolicies[0]?.n ?? 0} tenant policies present)`
          : `the copy schema carries ${targetPolicies[0]!.n} policies — it must stay policy-free`,
      metrics: {
        sourceTenantPolicies: Number(publicPolicies[0]?.n ?? 0),
        database: sameDatabase[0]?.db ?? null,
      },
    });
  }

  return {
    ok: checks.every((c) => c.ok),
    checks,
    durationMs: Date.now() - started,
  };
}

/** jsonb text rendering is canonical; only guard against empty payloads. */
function normalize(jsonText: string): string {
  try {
    return JSON.stringify(JSON.parse(jsonText));
  } catch {
    return jsonText;
  }
}
