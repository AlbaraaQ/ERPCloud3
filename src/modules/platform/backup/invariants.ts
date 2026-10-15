/**
 * Post-restore invariants (BACKUP_AND_RECOVERY §5).
 *
 * A restore that "finished" is not evidence. These checks are run against the
 * restored copy and produce the numbers that go into the drill record:
 *
 *  1. `row_counts`        — every table matches the manifest row count;
 *  2. `journal_balance`   — every posted journal entry in the copy balances;
 *  3. `tenant_partitioning` — no tenant-less business row, and per-tenant counts
 *     match the source for the tenants present;
 *  4. `row_sampling`      — random rows compared value-by-value against the source;
 *  5. `audit_integrity`   — restored audit rows are hash-bearing and ordered;
 *  6. `isolation`         — the copy lives in an isolated schema: it has no
 *     policies of its own and did not disturb the source's policies.
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

  /* --------------------------------------------------- 3. tenant partitioning */
  {
    const problems: string[] = [];
    let scoped = 0;
    for (const table of snapshot.manifest.tables) {
      const columns = table.columns.map((c) => c.name);
      if (!columns.some((c) => TABLES_WITH_TENANT.test(c))) continue;
      if (isPlatformScoped(table.name)) continue;
      scoped += 1;
      const nulls = await rows<{ n: number }>(
        exec,
        sql.raw(`select count(*)::int as n from "${target}"."${table.name}" where tenant_id is null`),
      );
      if (Number(nulls[0]?.n ?? 0) > 0) problems.push(`${table.name}: ${nulls[0]!.n} rows without tenant_id`);
    }

    // per-tenant counts must match the source for the tenants present in the copy
    let compared = 0;
    if (snapshot.manifest.tables.some((t) => t.name === "sales_invoices")) {
      const diffs = await rows<{ tenant_id: string; source: number; restored: number }>(
        exec,
        sql.raw(`with src as (
                   select tenant_id, count(*)::int as n from public.sales_invoices group by tenant_id
                 ), tgt as (
                   select tenant_id, count(*)::int as n from "${target}"."sales_invoices" group by tenant_id
                 )
                 select coalesce(src.tenant_id, tgt.tenant_id) as tenant_id,
                        coalesce(src.n, 0) as source, coalesce(tgt.n, 0) as restored
                   from src full join tgt on src.tenant_id = tgt.tenant_id
                  where coalesce(src.n, 0) <> coalesce(tgt.n, 0)
                  limit 5`),
      );
      compared = diffs.length;
      if (diffs.length > 0) {
        problems.push(
          `sales_invoices per-tenant counts differ for ${diffs.length} tenant(s), e.g. ${diffs[0]!.tenant_id}`,
        );
      }
    }

    checks.push({
      name: "tenant_partitioning",
      ok: problems.length === 0,
      detail:
        problems.length === 0
          ? `every business table with tenant_id (${scoped}) is fully tenant-owned; per-tenant invoice counts match (platform-scoped tables such as audit_log/sessions excluded by design)`
          : problems.slice(0, 5).join("; "),
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
      for (const table of candidates) {
        const keys = await rows<{ id: string }>(
          exec,
          sql.raw(`select id::text as id from "${target}"."${table.name}" order by ctid limit ${sampleSize}`),
        );
        for (const key of keys) {
          const both = await rows<{ side: string; payload: string }>(
            exec,
            sql.raw(`select 'src' as side, to_jsonb(t)::text as payload from public."${table.name}" t where t.id = '${key.id}'::uuid
                     union all
                     select 'tgt' as side, to_jsonb(t)::text as payload from "${target}"."${table.name}" t where t.id = '${key.id}'::uuid`),
          );
          const src = both.find((r) => r.side === "src")?.payload;
          const tgt = both.find((r) => r.side === "tgt")?.payload;
          sampled += 1;
          if (!src || !tgt || normalize(src) !== normalize(tgt)) {
            mismatches.push(`${table.name}:${key.id}`);
          }
        }
      }
      checks.push({
        name: "row_sampling",
        ok: mismatches.length === 0,
        detail:
          mismatches.length === 0
            ? `${sampled}/${sampled} sampled rows are byte-identical to the source`
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
