/**
 * Print the Phase-7 reconciliation pack (RL-1…RL-5) for one tenant.
 *
 * Usage:  DATABASE_URL=... npx tsx scripts/reports-check.mts [tenantId|email]
 *
 * This is the same `runReconciliations` the /reports page banner runs, so the CLI can be
 * used in operations to explain a red banner without opening the UI.
 */
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { tenants, users } from "@/db/schema";
import { withTenant } from "@/modules/shared/db-context";
import { runReconciliations } from "@/modules/reports/reconcile";

const target = process.argv[2];
let tenantId = target ?? "";
let territory = "the tenant with the most postings";

if (target && target.includes("@")) {
  const [user] = await db.select().from(users).where(eq(users.email, target)).limit(1);
  if (!user) throw new Error(`no user with email ${target}`);
  tenantId = user.tenantId;
  territory = target;
} else if (!target) {
  const rows = await db.execute(sql`
    select tenant_id from journal_entries group by tenant_id order by count(*) desc limit 1
  `);
  tenantId = (rows as unknown as { rows: { tenant_id: string }[] }).rows[0]?.tenant_id ?? "";
}
if (!tenantId) throw new Error("no tenant found");

const [tenant] = await db
  .select({ id: tenants.id, name: tenants.name })
  .from(tenants)
  .where(and(eq(tenants.id, tenantId)))
  .limit(1);

const first = (await db.execute(sql`
  select min(business_date) as d, max(business_date) as l
  from journal_entries where tenant_id = ${tenantId} and status = 'posted'
`)) as unknown as { rows: { d: string | null; l: string | null }[] };
const from = first.rows[0]?.d ?? undefined;
const to = first.rows[0]?.l ?? undefined;
const today = new Date().toISOString().slice(0, 10);

console.log(`tenant: ${tenant?.name ?? tenantId} (${territory})`);
console.log(`range : ${from ?? "—"} → ${to ?? "—"}`);
await withTenant(tenantId, async (trx) => {
  const pack = await runReconciliations(trx, tenantId, { from, to }, today);
  for (const r of pack.results) {
    console.log(
      `${r.ok ? "OK  " : "FAIL"} ${r.code} ${r.titleKey.padEnd(22)} left=${r.left} right=${r.right} diff=${r.difference}` +
        (r.note ? `  — ${r.note}` : ""),
    );
  }
  console.log(`breaches: ${pack.breaches}`);
});
process.exit(0);
