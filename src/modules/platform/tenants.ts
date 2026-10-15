/**
 * Tenant lifecycle (PLATFORM_ADMIN §1.1) — create, suspend, reactivate,
 * deactivate, plan change, flags. Every mutation lands in the platform audit
 * chain AND in the affected tenant's own audit view (a tenant must always be
 * able to see what the platform did to its account).
 *
 * Non-negotiable rules encoded here:
 *   - deactivation is LOGICAL: no code path in this module deletes tenant rows;
 *   - suspension keeps history and flips the tenant to read-only (enforced in
 *     `withTenant`, not by asking callers to remember);
 *   - plan/quota/flag changes are audited with before/after values.
 */

import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  branches,
  companies,
  employees,
  featureFlags,
  notifications,
  plans,
  roles,
  rolePermissions,
  subscriptions,
  tenants,
  userRoles,
  users,
  warehouses,
  treasuryAccounts,
} from "@/db/schema";
import { hashPassword } from "@/modules/identity/auth";
import { PERMISSIONS, ROLE_PRESETS } from "@/modules/shared/permissions";
import { withTenant, type Trx } from "@/modules/shared/db-context";
import { errors } from "@/modules/shared/result";
import { newId } from "@/modules/shared/ids";
import { ensureCoa, ensureMappings } from "@/modules/accounting/coa";
import { ensureFiscalYear } from "@/modules/accounting/periods";
import { writePlatformAudit, type PlatformAuditInput } from "./audit";
import { effectiveEntitlements, quotaState } from "./plans";

export type TenantStatus = "trial" | "active" | "suspended" | "deactivated";

/** Allowed transitions — anything else is a bug, not a policy decision. */
export const TENANT_TRANSITIONS: Record<TenantStatus, TenantStatus[]> = {
  trial: ["active", "suspended", "deactivated"],
  active: ["suspended", "deactivated"],
  suspended: ["active", "deactivated"],
  deactivated: ["active"],
};

export function assertTransition(from: TenantStatus, to: TenantStatus): void {
  if (!TENANT_TRANSITIONS[from]?.includes(to)) {
    throw errors.validation(
      "errors.platformTransitionInvalid",
      `illegal tenant transition ${from} → ${to}`,
    );
  }
}

export async function loadTenant(tenantId: string) {
  const [row] = await db.select().from(tenants).where(eq(tenants.id, tenantId)).limit(1);
  if (!row) throw errors.notFound("tenant", tenantId);
  return row;
}

export interface TenantListRow {
  id: string;
  name: string;
  nameEn: string | null;
  status: TenantStatus;
  plan: string;
  createdAt: Date;
  users: number;
  lastPostingAt: string | null;
}

export async function listTenants(opts: { status?: TenantStatus; q?: string } = {}): Promise<TenantListRow[]> {
  const rows = await db.execute(sql`
    select t.id, t.name, t.name_en, t.status::text as status, t.plan, t.created_at,
           (select count(*) from users u where u.tenant_id = t.id)::int as users,
           (select max(j.business_date)::text from journal_entries j
             where j.tenant_id = t.id and j.status = 'posted') as last_posting_at
    from tenants t
    where ${opts.status ? sql`t.status = ${opts.status}::tenant_status` : sql`true`}
      and ${opts.q ? sql`(t.name ilike ${"%" + opts.q + "%"} or coalesce(t.name_en,'') ilike ${"%" + opts.q + "%"})` : sql`true`}
    order by t.created_at desc
  `);
  return (
    rows as unknown as {
      rows: {
        id: string;
        name: string;
        name_en: string | null;
        status: TenantStatus;
        plan: string;
        created_at: Date;
        users: number;
        last_posting_at: string | null;
      }[];
    }
  ).rows.map((r) => ({
    id: r.id,
    name: r.name,
    nameEn: r.name_en,
    status: r.status,
    plan: r.plan,
    createdAt: new Date(r.created_at),
    users: Number(r.users),
    lastPostingAt: r.last_posting_at,
  }));
}

export async function tenantStatusCounts(): Promise<Record<string, number>> {
  const rows = await db
    .select({ status: tenants.status, n: sql<number>`count(*)::int` })
    .from(tenants)
    .groupBy(tenants.status);
  const out: Record<string, number> = { trial: 0, active: 0, suspended: 0, deactivated: 0 };
  for (const row of rows) out[row.status] = Number(row.n);
  return out;
}

/* ------------------------------------------------------------------ lifecycle */

export interface ProvisionTenantInput {
  name: string;
  nameEn?: string | null;
  legalName: string;
  vatNumber?: string | null;
  planCode: string;
  trialDays?: number;
  ownerEmail: string;
  ownerName: string;
  ownerPassword: string;
  /** Actor label for the audit trail (platform actor). */
  actorLabel: string;
  actorPlatformUserId?: string | null;
}

/**
 * Create a tenant with everything it needs to be usable: identity, preset roles,
 * owner user, default warehouse, chart of accounts + posting mappings + open
 * fiscal year, treasury accounts and a subscription. No demo data.
 */
export async function provisionTenant(input: ProvisionTenantInput): Promise<{ tenantId: string; ownerUserId: string }> {
  const plan = await db.select().from(plans).where(eq(plans.code, input.planCode)).limit(1);
  if (plan.length === 0) throw errors.validation("errors.planUnknown", `plan ${input.planCode}`);
  const email = input.ownerEmail.trim().toLowerCase();
  if (!input.ownerPassword || input.ownerPassword.length < 12) {
    throw errors.validation("errors.platformPasswordWeak", "owner password must be at least 12 chars");
  }

  const tenantId = newId();
  const ownerUserId = newId();

  await db.insert(tenants).values({
    id: tenantId,
    name: input.name,
    nameEn: input.nameEn ?? null,
    status: "trial",
    plan: input.planCode,
  });

  const passwordHash = await hashPassword(input.ownerPassword);

  await withTenant(
    tenantId,
    async (trx) => {
      await trx.insert(companies).values({
        tenantId,
        legalName: input.legalName,
        vatNumber: input.vatNumber ?? null,
      });
      await trx.insert(branches).values({ tenantId, code: "HQ", name: input.name, isDefault: true });

      // preset roles (same catalog the seed uses — one source of truth)
      const roleIds: Record<string, string> = {};
      for (const [key, preset] of Object.entries(ROLE_PRESETS)) {
        const [role] = await trx
          .insert(roles)
          .values({ tenantId, key, nameAr: preset.nameAr, nameEn: preset.nameEn, isSystem: true })
          .returning({ id: roles.id });
        roleIds[key] = role.id;
        for (const code of preset.permissions) {
          await trx.insert(rolePermissions).values({ roleId: role.id, permissionCode: code }).onConflictDoNothing();
        }
      }

      await trx.insert(users).values({
        id: ownerUserId,
        tenantId,
        email,
        passwordHash,
        name: input.ownerName,
        isOwner: true,
      });
      const ownerRoleId = roleIds.tenant_owner;
      if (ownerRoleId) {
        await trx.insert(userRoles).values({ tenantId, userId: ownerUserId, roleId: ownerRoleId });
      }
      await trx.insert(employees).values({
        tenantId,
        userId: ownerUserId,
        fullName: input.ownerName,
        jobTitle: "tenant_owner",
      });

      await trx.insert(warehouses).values({ tenantId, code: "MAIN", name: "المستودع الرئيسي", type: "main" });

      await ensureCoa(trx, tenantId);
      await ensureMappings(trx, tenantId);
      await ensureFiscalYear(trx, tenantId, new Date().getUTCFullYear());

      await trx.insert(treasuryAccounts).values([
        { tenantId, code: "CASH-001", name: "الصندوق النقدي", kind: "cash" },
        { tenantId, code: "BANK-001", name: "الحساب البنكي", kind: "bank" },
      ]);
    },
    // the tenant is created as `trial` (writable); the flag documents intent
    { writable: true },
  );

  const trialDays = input.trialDays ?? 14;
  await db.insert(subscriptions).values({
    id: newId(),
    tenantId,
    planCode: input.planCode,
    status: "trialing",
    trialEndsAt: new Date(Date.now() + trialDays * 24 * 3600 * 1000),
  });

  await writePlatformAudit(db, {
    actorPlatformUserId: input.actorPlatformUserId ?? null,
    actorLabel: input.actorLabel,
    action: "tenant.created",
    entity: "tenant",
    entityId: tenantId,
    after: { name: input.name, plan: input.planCode, owner: email, trialDays },
    alsoAuditTenantId: tenantId,
  });

  return { tenantId, ownerUserId };
}

export interface SetTenantStatusInput {
  tenantId: string;
  to: TenantStatus;
  reason: string;
  actorLabel: string;
  actorPlatformUserId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}

/**
 * Suspend / reactivate / deactivate. Never deletes anything: `deactivated` is a
 * logical state and the tenant keeps its history (read-only) until the deletion
 * workflow (§5) has run its course.
 */
export async function setTenantStatus(input: SetTenantStatusInput): Promise<{ from: TenantStatus; to: TenantStatus }> {
  const current = await loadTenant(input.tenantId);
  const from = current.status as TenantStatus;
  assertTransition(from, input.to);
  if (!input.reason?.trim()) {
    throw errors.validation("errors.platformReasonRequired", "reason is mandatory");
  }

  const audit: PlatformAuditInput = {
    actorPlatformUserId: input.actorPlatformUserId ?? null,
    actorLabel: input.actorLabel,
    action: `tenant.${input.to}`,
    entity: "tenant",
    entityId: input.tenantId,
    before: { status: from },
    after: { status: input.to, reason: input.reason },
    ip: input.ip ?? null,
    userAgent: input.userAgent ?? null,
    alsoAuditTenantId: input.tenantId,
  };

  await withTenant(
    input.tenantId,
    async (trx) => {
      // Tell the tenant's owner what happened and why — the notification is
      // written before the status flip while the tenant is still writable.
      const [owner] = await trx
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.tenantId, input.tenantId), eq(users.isOwner, true)))
        .limit(1);
      if (owner) {
        await trx.insert(notifications).values({
          tenantId: input.tenantId,
          userId: owner.id,
          kind: `platform.tenant_${input.to}`,
          title:
            input.to === "suspended"
              ? "تم إيقاف الاشتراك مؤقتاً — الحساب للقراءة فقط"
              : input.to === "deactivated"
                ? "انتهى الاشتراك — الحساب للقراءة فقط مع إمكانية التصدير"
                : "تم تنشيط الاشتراك",
          body: input.reason,
          payload: { status: input.to },
        });
      }
      await trx.update(tenants).set({ status: input.to, updatedAt: new Date() }).where(eq(tenants.id, input.tenantId));
    },
    { writable: true }, // platform lifecycle operation — the audit trail is the control here
  );

  await writePlatformAudit(db, audit);
  return { from, to: input.to };
}

export async function setTenantPlan(input: {
  tenantId: string;
  planCode: string;
  actorLabel: string;
  actorPlatformUserId?: string | null;
  renewsAt?: Date | null;
}): Promise<void> {
  const plan = await db.select().from(plans).where(eq(plans.code, input.planCode)).limit(1);
  if (plan.length === 0) throw errors.validation("errors.planUnknown", `plan ${input.planCode}`);
  const current = await loadTenant(input.tenantId);
  const [existing] = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.tenantId, input.tenantId))
    .limit(1);

  if (existing) {
    await db
      .update(subscriptions)
      .set({
        planCode: input.planCode,
        renewsAt: input.renewsAt ?? existing.renewsAt,
        status: existing.status === "trialing" ? "active" : existing.status,
        updatedAt: new Date(),
      })
      .where(eq(subscriptions.id, existing.id));
  } else {
    await db.insert(subscriptions).values({
      id: newId(),
      tenantId: input.tenantId,
      planCode: input.planCode,
      status: "active",
      renewsAt: input.renewsAt ?? null,
    });
  }
  await db.update(tenants).set({ plan: input.planCode, updatedAt: new Date() }).where(eq(tenants.id, input.tenantId));

  await writePlatformAudit(db, {
    actorPlatformUserId: input.actorPlatformUserId ?? null,
    actorLabel: input.actorLabel,
    action: "tenant.plan_changed",
    entity: "tenant",
    entityId: input.tenantId,
    before: { plan: current.plan },
    after: { plan: input.planCode, renewsAt: input.renewsAt ?? null },
    alsoAuditTenantId: input.tenantId,
  });
}

/* ------------------------------------------------------------------- flags */

export async function listFlags(tenantId?: string) {
  return db
    .select()
    .from(featureFlags)
    .where(tenantId ? sql`${featureFlags.tenantId} = ${tenantId} or ${featureFlags.tenantId} is null` : sql`true`)
    .orderBy(featureFlags.scope, featureFlags.key);
}

/**
 * Set a flag. Global flags are rows with `tenant_id is null`; a tenant row
 * overrides the global value. Cached per request only — immediate effect.
 */
export async function setFlag(input: {
  tenantId: string | null;
  key: string;
  enabled: boolean;
  note?: string | null;
  actorLabel: string;
  actorPlatformUserId?: string | null;
}): Promise<void> {
  const key = input.key.trim();
  if (!/^[a-z0-9_]{3,60}$/.test(key)) {
    throw errors.validation("errors.platformFlagKeyInvalid", `bad flag key: ${key}`);
  }
  const [existing] = await db
    .select()
    .from(featureFlags)
    .where(
      and(
        eq(featureFlags.key, key),
        input.tenantId ? eq(featureFlags.tenantId, input.tenantId) : isNull(featureFlags.tenantId),
      ),
    )
    .limit(1);

  if (existing) {
    await db
      .update(featureFlags)
      .set({
        enabled: input.enabled,
        note: input.note ?? existing.note,
        updatedAt: new Date(),
        updatedByLabel: input.actorLabel,
      })
      .where(eq(featureFlags.id, existing.id));
  } else {
    await db.insert(featureFlags).values({
      id: newId(),
      scope: input.tenantId ? "tenant" : "global",
      tenantId: input.tenantId,
      key,
      enabled: input.enabled,
      note: input.note ?? null,
      updatedByLabel: input.actorLabel,
    });
  }

  await writePlatformAudit(db, {
    actorPlatformUserId: input.actorPlatformUserId ?? null,
    actorLabel: input.actorLabel,
    action: "flag.changed",
    entity: "feature_flag",
    entityId: `${input.tenantId ?? "global"}:${key}`,
    before: existing ? { enabled: existing.enabled } : null,
    after: { enabled: input.enabled, note: input.note ?? null },
    alsoAuditTenantId: input.tenantId,
  });
}

/** Effective flag value: tenant override wins, then global, then plan features. */
export async function effectiveFlags(tenantId: string): Promise<Record<string, boolean>> {
  const rows = await db
    .select({ tenantId: featureFlags.tenantId, key: featureFlags.key, enabled: featureFlags.enabled })
    .from(featureFlags)
    .where(sql`${featureFlags.tenantId} = ${tenantId} or ${featureFlags.tenantId} is null`);
  const out: Record<string, boolean> = {};
  for (const row of rows.filter((r) => r.tenantId === null)) out[row.key] = row.enabled;
  for (const row of rows.filter((r) => r.tenantId !== null)) out[row.key] = row.enabled;
  const { features } = await effectiveEntitlements(tenantId);
  for (const feature of features) out[feature] = true;
  return out;
}

export async function isFeatureEnabled(tenantId: string, key: string): Promise<boolean> {
  return (await effectiveFlags(tenantId))[key] ?? false;
}

/* ------------------------------------------------------------- console detail */

export interface TenantOverview {
  tenant: {
    id: string;
    name: string;
    nameEn: string | null;
    status: TenantStatus;
    plan: string;
    createdAt: Date;
  };
  company: { legalName: string; vatNumber: string | null; timezone: string } | null;
  subscription: { planCode: string; status: string; renewsAt: Date | null; trialEndsAt: Date | null } | null;
  counts: { users: number; branches: number; warehouses: number; products: number; customers: number };
  activity: { postedJournals: number; stockMovements: number; lastPosting: string | null };
  quotas: Awaited<ReturnType<typeof quotaState>>;
  flags: Record<string, boolean>;
}

/** Platform-safe tenant overview: counts and configuration only — no amounts. */
export async function tenantOverview(tenantId: string): Promise<TenantOverview> {
  const tenant = await loadTenant(tenantId);
  const [sub] = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.tenantId, tenantId))
    .limit(1);

  const detail = await withTenant(tenantId, async (trx) => {
    const rows = (await trx.execute(sql`
      select
        (select count(*) from users)::int as users,
        (select count(*) from branches)::int as branches,
        (select count(*) from warehouses)::int as warehouses,
        (select count(*) from products)::int as products,
        (select count(*) from customers)::int as customers,
        (select count(*) from journal_entries where status = 'posted')::int as posted_journals,
        (select count(*) from stock_ledger)::int as stock_movements,
        (select max(business_date)::text from journal_entries where status = 'posted') as last_posting
    `)) as unknown as {
      rows: {
        users: number;
        branches: number;
        warehouses: number;
        products: number;
        customers: number;
        posted_journals: number;
        stock_movements: number;
        last_posting: string | null;
      }[];
    };
    const [company] = await trx
      .select({
        legalName: companies.legalName,
        vatNumber: companies.vatNumber,
        timezone: companies.timezone,
      })
      .from(companies)
      .where(eq(companies.tenantId, tenantId))
      .limit(1);
    const quotas = await quotaState(trx, tenantId);
    return { ...rows.rows[0]!, company: company ?? null, quotas };
  });

  return {
    tenant: {
      id: tenant.id,
      name: tenant.name,
      nameEn: tenant.nameEn,
      status: tenant.status as TenantStatus,
      plan: tenant.plan,
      createdAt: tenant.createdAt,
    },
    company: detail.company,
    subscription: sub
      ? {
          planCode: sub.planCode,
          status: sub.status,
          renewsAt: sub.renewsAt,
          trialEndsAt: sub.trialEndsAt,
        }
      : null,
    counts: {
      users: Number(detail.users ?? 0),
      branches: Number(detail.branches ?? 0),
      warehouses: Number(detail.warehouses ?? 0),
      products: Number(detail.products ?? 0),
      customers: Number(detail.customers ?? 0),
    },
    activity: {
      postedJournals: Number(detail.posted_journals ?? 0),
      stockMovements: Number(detail.stock_movements ?? 0),
      lastPosting: detail.last_posting ?? null,
    },
    quotas: detail.quotas,
    flags: await effectiveFlags(tenantId),
  };
}

/** Permission catalog size check — used by tests to prove presets stay valid. */
export function knownPermissionCount(): number {
  return PERMISSIONS.length;
}

export type { Trx };
