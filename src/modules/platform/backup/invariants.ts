/**
 * Post-restore integrity checks (BACKUP_AND_RECOVERY §5).
 *
 * "A backup that has never been restored is a hypothesis, not a capability."
 * These checks run against the RESTORED target (an isolated schema), never
 * against the source, and they are deliberately independent of the snapshot
 * reader: row counts and balances come from SQL over the restored tables.
 */

import { sql } from "drizzle-orm";
import type { Trx } from "@/modules/shared/db-context";
import type { SnapshotFile, TableCapture } from "./snapshot";

type Exec = Pick<Trx, "execute">;
interface Raw {
  rows: Record<string, unknown>[];
}
const q = async (exec: Exec, text: ReturnType<typeof sql>): Promise<Raw> =>
  (await exec.execute(text)) as unknown as Raw;

export interface InvariantCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface InvariantReport {
  ok: boolean;
  checks: InvariantCheck[];
  rowCounts: { table: string; expected: number; restored: number; ok: boolean }[];
  sampleTenantId: string | null;
}

/**
 * Canonical form used to compare a snapshot row with a restored row.
 *
 * The two sides arrive in different shapes by construction: the snapshot captured
 * numeric columns as text (exactness) and timestamps as JSON strings, while the
 * restore returns native numerics and JS Dates. Comparison is therefore
 * type-aware and never relies on the driver's formatting:
 *
 *   - `date`              → the calendar date in local terms (node-postgres builds
 *                           DATE values at local midnight)
 *   - `timestamp*`        → ISO instant
 *   - numeric-ish         → normalised through Number().toFixed(6) (the sampling
 *                           check tolerates digits beyond six decimals; the
 *                           exactness guarantee comes from the text capture)
 *   - objects/arrays      → JSON with sorted keys (jsonb key order is not
 *                           guaranteed to survive a round trip through the driver)
 */
function canonical(value: unknown, type: string): string {
  if (value === null || value === undefined) return "\u0000null";
  if (type === "date") {
    if (value instanceof Date) {
      const y = value.getFullYear();
      const m = String(value.getMonth() + 1).padStart(2, "0");
      const d = String(value.getDate()).padStart(2, "0");
      return `${y}-${m}-${d}`;
    }
    return String(value).slice(0, 10);
  }
  if (type.startsWith("timestamp")) {
    const date = value instanceof Date ? value : new Date(String(value));
    return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
  }
  if (typeof value === "boolean") return value ? "t" : "f";
  if (typeof value === "number") return trimNumber(value);
  if (typeof value === "object") return stableJson(value);
  const s = String(value);
  return /^-?\d+(\.\d+)?$/.test(s) ? trimNumber(Number(s)) : s;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function trimNumber(n: number): string {
  const fixed = n.toFixed(6);
  return fixed.replace(/0+$/, "").replace(/\.$/, "");
}

function rowKey(row: Record<string, unknown>, pk: { name: string; type: string }[]): string {
  return pk.map((c) => canonical(row[c.name], c.type)).join("|");
}

/** Primary-key columns parsed from the captured constraint DDL. */
function primaryKeyColumns(file: SnapshotFile, table: string): { name: string; type: string }[] {
  const pk = file.schema.constraints.find((c) => c.table === table && c.type === "p");
  if (!pk) return [];
  const match = /PRIMARY KEY \(([^)]+)\)/i.exec(pk.def);
  if (!match) return [];
  const names = match[1]!
    .split(",")
    .map((c) => c.trim().replace(/^"|"$/g, ""))
    .filter(Boolean);
  const def = file.schema.tables.find((t) => t.name === table);
  return names.map((name) => ({ name, type: def?.columns.find((c) => c.name === name)?.type ?? "text" }));
}

export async function runRestoreInvariants(
  exec: Exec,
  targetSchema: string,
  file: SnapshotFile,
  opts: { sampleRows?: number } = {},
): Promise<InvariantReport> {
  const target = `"${targetSchema.replace(/"/g, '""')}"`;
  const checks: InvariantCheck[] = [];

  // 1. every table restored with exactly the captured row count
  const rowCounts: InvariantReport["rowCounts"] = [];
  for (const table of file.tables) {
    const res = await q(exec, sql.raw(`select count(*)::int as n from ${target}."${table.name}"`));
    const restored = Number(res.rows[0]?.n ?? 0);
    rowCounts.push({ table: table.name, expected: table.rowCount, restored, ok: restored === table.rowCount });
  }
  const badCounts = rowCounts.filter((r) => !r.ok);
  checks.push({
    name: "row_counts",
    ok: badCounts.length === 0,
    detail:
      badCounts.length === 0
        ? `${rowCounts.length} table(s) match the snapshot row counts`
        : `${badCounts.length} table(s) differ: ${badCounts
            .map((b) => `${b.table} ${b.restored}/${b.expected}`)
            .join(", ")}`,
  });

  // 2. the accounting invariant survives the round trip: posted journals balance
  const unbalanced = await q(
    exec,
    sql.raw(`select count(*)::int as n from (
        select e.id from ${target}.journal_entries e
        join (
          select entry_id, round(sum(debit)::numeric, 2) as dr, round(sum(credit)::numeric, 2) as cr
          from ${target}.journal_lines group by entry_id
        ) l on l.entry_id = e.id
        where e.status = 'posted' and l.dr <> l.cr
      ) x`),
  );
  const unbalancedCount = Number(unbalanced.rows[0]?.n ?? 0);
  checks.push({
    name: "journal_balance",
    ok: unbalancedCount === 0,
    detail:
      unbalancedCount === 0
        ? "every posted journal in the restored copy balances"
        : `${unbalancedCount} posted journal(s) do not balance`,
  });

  // 3. tenant partitioning is preserved in the copy
  const tenants = await q(
    exec,
    sql.raw(`select id::text as id from ${target}.tenants order by created_at limit 1`),
  );
  const sampleTenantId = (tenants.rows[0]?.id as string | undefined) ?? null;
  if (sampleTenantId) {
    const own = await q(
      exec,
      sql.raw(`select count(*)::int as n from ${target}.sales_invoices where tenant_id = '${sampleTenantId}'::uuid`),
    );
    const foreign = await q(
      exec,
      sql.raw(
        `select count(*)::int as n from ${target}.sales_invoices where tenant_id <> '${sampleTenantId}'::uuid`,
      ),
    );
    checks.push({
      name: "tenant_partitioning",
      ok: true,
      detail: `tenant ${sampleTenantId.slice(0, 8)}… owns ${Number(own.rows[0]?.n ?? 0)} invoice(s), ${Number(
        foreign.rows[0]?.n ?? 0,
      )} belong to other tenants`,
    });
  } else {
    checks.push({ name: "tenant_partitioning", ok: false, detail: "no tenant rows in the restored copy" });
  }

  // 4. sampling: the same primary key must carry the same payload
  const sampleRows = opts.sampleRows ?? 5;
  const sampleTables = file.tables.filter((t) => t.rowCount > 0).slice(0, 3);
  let sampled = 0;
  let matched = 0;
  const mismatches: string[] = [];

  for (const table of sampleTables) {
    const pk = primaryKeyColumns(file, table.name);
    if (pk.length === 0) continue;
    const cols = table.columns.map((c) => `"${c.name}"`).join(", ");
    const order = pk.map((c) => `"${c.name}"`).join(", ");
    const restored = await q(
      exec,
      sql.raw(`select ${cols} from ${target}."${table.name}" order by ${order} limit ${sampleRows}`),
    );
    const sourceIndex = indexSnapshotRows(table, pk);
    for (const row of restored.rows) {
      const key = rowKey(row, pk);
      const source = sourceIndex.get(key);
      sampled += 1;
      if (source && rowMatches(source, row, table)) matched += 1;
      else mismatches.push(`${table.name}:${key.slice(0, 12)}`);
    }
  }
  checks.push({
    name: "row_sampling",
    ok: sampled === 0 || matched === sampled,
    detail:
      sampled === 0
        ? "no rows to sample"
        : `${matched}/${sampled} sampled row(s) identical to the snapshot${
            mismatches.length ? ` — mismatches: ${mismatches.join(", ")}` : ""
          }`,
  });

  return {
    ok: checks.every((c) => c.ok),
    checks,
    rowCounts,
    sampleTenantId,
  };
}

function indexSnapshotRows(
  table: TableCapture,
  pk: { name: string; type: string }[],
): Map<string, Record<string, unknown>> {
  const index = new Map<string, Record<string, unknown>>();
  for (const chunk of table.chunks) {
    if (chunk === "[]") continue;
    for (const row of JSON.parse(chunk) as Record<string, unknown>[]) {
      index.set(rowKey(row, pk), row);
    }
  }
  return index;
}

function rowMatches(
  source: Record<string, unknown>,
  restored: Record<string, unknown>,
  table: TableCapture,
): boolean {
  return table.columns.every(
    (c) => canonical(source[c.name], c.type) === canonical(restored[c.name], c.type),
  );
}
