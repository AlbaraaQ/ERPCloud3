/**
 * Plans, entitlements, quotas and usage metering (PLATFORM_ADMIN §1.1–§1.2).
 *
 * One rule matters more than the rest: a quota is enforced **at the write
 * boundary** from the same numbers the console shows, so "exceeded → warnings
 * then hard blocks" is not a UI promise. Everything here works on counts — the
 * platform tier never reads tenant document content.
 */

import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { plans, subscriptions, tenants, usageMetrics, type PlanEntitlements } from "@/db/schema";
import { errors } from "@/modules/shared/result";
import type { DbExecutor, Trx } from "@/modules/shared/db-context";
import { newId } from "@/modules/shared/ids";
import { monthOf, monthRange, todayBusinessDate } from "@/modules/shared/dates";

export type QuotaMetric = "users" | "branches" | "warehouses" | "invoicesPerMonth";

/** Feature keys the platform can gate (PLATFORM_ADMIN §1.3). */
export const KNOWN_FEATURES = [
  "manufacturing",
  "ai_assistant",
  "drive_backup",
  "van_sales",
  "multi_currency",
  "e_invoicing",
] as const;

export interface QuotaState {
  metric: QuotaMetric;
  used: number;
  limit: number | null;
  /** usage ratio, null when unlimited */
  ratio: number | null;
  warning: boolean;
  exceeded: boolean;
}

export async function listPlans(includeInactive = true) {
  const rows = await db.select().from(plans).orderBy(plans.sortOrder, plans.code);
  return includeInactive ? rows : rows.filter((p) => p.isActive);
}

export async function getPlan(code: string, exec: DbExecutor = db) {
  const [row] = await exec.select().from(plans).where(eq(plans.code, code)).limit(1);
  return row ?? null;
}

/** Effective entitlements for a tenant: subscription plan, else the tenant's plan column. */
export async function effectiveEntitlements(
  tenantId: string,
  exec: DbExecutor = db,
): Promise<{ planCode: string; entitlements: PlanEntitlements; features: Set<string> }> {
  const [sub] = await exec
    .select({ planCode: subscriptions.planCode })
    .from(subscriptions)
    .where(eq(subscriptions.tenantId, tenantId))
    .limit(1);
  const [tenant] = await exec
    .select({ plan: tenants.plan })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  const code = sub?.planCode ?? tenant?.plan ?? "trial";
  const plan = await getPlan(code, exec);
  const entitlements = plan?.entitlements ?? {};
  return { planCode: code, entitlements, features: new Set(entitlements.features ?? []) };
}

/* ------------------------------------------------------------------- metering */

/**
 * Current usage per quota metric. All counts are tenant-scoped (RLS binds to
 * the tenant) and cheap: indexed counts, no document content.
 */
export async function currentUsage(trx: Trx, tenantId: string): Promise<Record<QuotaMetric, number>> {
  // `business_date` is an ISO `YYYY-MM-DD` string everywhere in this schema
  // (D-00x business-date rule), so the month window is built in TypeScript in the
  // tenant timezone and compared as text — casting the column to date would
  // bypass its index and mix two date semantics in one query.
  const month = monthRange(monthOf(todayBusinessDate()));
  const rows = (await trx.execute(sql`
    select
      (select count(*) from users where tenant_id = ${tenantId}::uuid)::int as users,
      (select count(*) from branches where tenant_id = ${tenantId}::uuid)::int as branches,
      (select count(*) from warehouses where tenant_id = ${tenantId}::uuid)::int as warehouses,
      (select count(*) from sales_invoices
        where tenant_id = ${tenantId}::uuid
          and business_date >= ${month.from}
          and business_date <= ${month.to}
          and business_status <> 'draft')::int as invoices_month
  `)) as unknown as {
    rows: { users: number; branches: number; warehouses: number; invoices_month: number }[];
  };
  const r = rows.rows[0];
  return {
    users: Number(r?.users ?? 0),
    branches: Number(r?.branches ?? 0),
    warehouses: Number(r?.warehouses ?? 0),
    invoicesPerMonth: Number(r?.invoices_month ?? 0),
  };
}

export async function quotaState(trx: Trx, tenantId: string): Promise<QuotaState[]> {
  const { entitlements } = await effectiveEntitlements(tenantId, trx);
  const usage = await currentUsage(trx, tenantId);
  const quotas = entitlements.quotas ?? {};
  const metrics: QuotaMetric[] = ["users", "branches", "warehouses", "invoicesPerMonth"];
  return metrics.map((metric) => {
    const limit = quotas[metric] ?? null;
    const used = usage[metric] ?? 0;
    const ratio = limit && limit > 0 ? used / limit : null;
    return {
      metric,
      used,
      limit: limit ?? null,
      ratio,
      warning: ratio !== null && ratio >= 0.8 && ratio < 1,
      exceeded: ratio !== null && ratio >= 1,
    };
  });
}

/**
 * Hard block at the write boundary. `metric` is the quota being consumed and
 * `increment` how many units this operation adds (1 for a new user/warehouse,
 * 1 invoice per document).
 */
export async function assertQuota(
  trx: Trx,
  tenantId: string,
  metric: QuotaMetric,
  increment = 1,
): Promise<void> {
  const state = (await quotaState(trx, tenantId)).find((s) => s.metric === metric);
  if (!state || state.limit === null) return;
  if (state.used + increment > state.limit) {
    throw errors.validation("errors.quotaExceeded", `quota ${metric} exceeded`, {
      metric,
      limit: state.limit,
      used: state.used,
      increment,
    });
  }
}

/** Record a usage sample (upsert per tenant/metric/period). */
export async function recordUsage(
  tenantId: string,
  metric: string,
  period: string,
  value: number,
): Promise<void> {
  await db
    .insert(usageMetrics)
    .values({ id: newId(), tenantId, metric, period, value: String(value) })
    .onConflictDoUpdate({
      target: [usageMetrics.tenantId, usageMetrics.metric, usageMetrics.period],
      set: { value: String(value), capturedAt: new Date() },
    });
}

/**
 * Capture the usage sample set for one tenant. `day` and `month` are provided by
 * the caller (tenant timezone is the tenant's own setting).
 */
export async function captureUsageForTenant(
  tenantId: string,
  opts: { day: string; month: string },
  withTenant: <T>(tenantId: string, fn: (trx: Trx) => Promise<T>) => Promise<T>,
): Promise<Record<string, number>> {
  const businessMonth = monthRange(opts.month);
  const counts = await withTenant(tenantId, async (trx) => {
    const rows = (await trx.execute(sql`
      select
        (select count(*) from users where tenant_id = ${tenantId}::uuid)::int as users,
        (select count(*) from branches where tenant_id = ${tenantId}::uuid)::int as branches,
        (select count(*) from warehouses where tenant_id = ${tenantId}::uuid)::int as warehouses,
        (select count(*) from products where tenant_id = ${tenantId}::uuid)::int as products,
        (select count(*) from customers where tenant_id = ${tenantId}::uuid)::int as customers,
        (select count(*) from representatives
          where tenant_id = ${tenantId}::uuid and status = 'active')::int as reps,
        (select count(*) from sales_invoices
          where tenant_id = ${tenantId}::uuid
            and business_date >= ${businessMonth.from} and business_date <= ${businessMonth.to}
            and business_status <> 'draft')::int as invoices_month,
        (select count(*) from receipts
          where tenant_id = ${tenantId}::uuid
            and business_date >= ${businessMonth.from} and business_date <= ${businessMonth.to})::int as receipts_month,
        (select count(*) from journal_entries
          where tenant_id = ${tenantId}::uuid and status = 'posted')::int as journals_posted,
        (select count(*) from invoice_submissions where tenant_id = ${tenantId}::uuid)::int as submissions
    `)) as unknown as { rows: Record<string, number>[] };
    return rows.rows[0] ?? {};
  });

  const metrics: Record<string, number> = {
    users: counts.users ?? 0,
    branches: counts.branches ?? 0,
    warehouses: counts.warehouses ?? 0,
    products: counts.products ?? 0,
    customers: counts.customers ?? 0,
    active_reps: counts.reps ?? 0,
    invoices_month: counts.invoices_month ?? 0,
    receipts_month: counts.receipts_month ?? 0,
    journals_posted: counts.journals_posted ?? 0,
    zatca_submissions: counts.submissions ?? 0,
  };
  for (const [metric, value] of Object.entries(metrics)) {
    await recordUsage(tenantId, metric, opts.month, value);
  }
  for (const metric of ["users", "active_reps", "invoices_month"]) {
    await recordUsage(tenantId, metric, opts.day, metrics[metric] ?? 0);
  }
  return metrics;
}

/** Tenants that carry a subscription in a non-active state (renewal reminders). */
export async function subscriptionsDue(withinDays = 14) {
  return db
    .select({
      tenantId: subscriptions.tenantId,
      planCode: subscriptions.planCode,
      status: subscriptions.status,
      renewsAt: subscriptions.renewsAt,
      trialEndsAt: subscriptions.trialEndsAt,
    })
    .from(subscriptions)
    .where(
      and(
        sql`${subscriptions.status} in ('trialing','active','past_due')`,
        sql`coalesce(${subscriptions.renewsAt}, ${subscriptions.trialEndsAt}) <= now() + (${withinDays} * interval '1 day')`,
      ),
    );
}
