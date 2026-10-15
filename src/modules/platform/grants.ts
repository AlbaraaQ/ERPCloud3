/**
 * Break-glass support access (PLATFORM_ADMIN §2).
 *
 * Default is ZERO access to tenant data. A grant is a row that records:
 *   - who asked (platform user with `platform.grants.request`),
 *   - who approved it (a different platform user with `platform.grants.approve`),
 *   - the tenant owner it was communicated to,
 *   - the scope (screens, amounts, exports — exports are off unless granted),
 *   - an expiry (≤ the configured maximum, 24 h by default).
 *
 * Every use is counted and audited; revocation is immediate. The tenant sees the
 * grant through its own audit view, and there is no impersonation anywhere: the
 * console renders side-by-side with a grant banner.
 */

import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { supportGrants, users } from "@/db/schema";
import { errors } from "@/modules/shared/result";
import { newId } from "@/modules/shared/ids";
import { writePlatformAudit } from "./audit";
import { getSettings } from "./settings";
import { GRANTABLE_SCREENS, type SupportScope } from "./permissions";

export interface CreateGrantInput {
  tenantId: string;
  requestedByPlatformUserId: string;
  tenantApprovedByUserId?: string | null;
  scope: SupportScope;
  reason: string;
  hours: number;
  actorLabel: string;
  ip?: string | null;
}

export async function requestGrant(input: CreateGrantInput): Promise<string> {
  const settings = await getSettings();
  if (!input.reason?.trim()) throw errors.validation("errors.platformReasonRequired", "reason is mandatory");
  const hours = Math.min(Math.max(1, input.hours), settings.supportGrantMaxHours);
  const screens = (input.scope.screens ?? []).filter((s) => (GRANTABLE_SCREENS as readonly string[]).includes(s));
  if (screens.length === 0) {
    throw errors.validation("errors.platformGrantScopeRequired", "at least one grantable screen is required");
  }

  const id = newId();
  await db.insert(supportGrants).values({
    id,
    tenantId: input.tenantId,
    requestedByPlatformUserId: input.requestedByPlatformUserId,
    tenantApprovedByUserId: input.tenantApprovedByUserId ?? null,
    scope: { screens, amounts: Boolean(input.scope.amounts), exports: Boolean(input.scope.exports) },
    reason: input.reason,
    expiresAt: new Date(Date.now() + hours * 3600_000),
  });

  await writePlatformAudit(db, {
    actorPlatformUserId: input.requestedByPlatformUserId,
    actorLabel: input.actorLabel,
    action: "grant.requested",
    entity: "support_grant",
    entityId: id,
    after: { tenantId: input.tenantId, scope: input.scope, hours, reason: input.reason },
    ip: input.ip ?? null,
    alsoAuditTenantId: input.tenantId,
  });
  return id;
}

/** Second person approves (or the request stays inert — it grants nothing until approved). */
export async function approveGrant(input: {
  grantId: string;
  approverPlatformUserId: string;
  approverRole: string;
  actorLabel: string;
  ip?: string | null;
}): Promise<void> {
  const [grant] = await db.select().from(supportGrants).where(eq(supportGrants.id, input.grantId)).limit(1);
  if (!grant) throw errors.notFound("support_grant", input.grantId);
  if (grant.requestedByPlatformUserId === input.approverPlatformUserId) {
    throw errors.validation(
      "errors.platformGrantTwoPerson",
      "the requester cannot approve their own grant (two-person rule)",
    );
  }
  await db
    .update(supportGrants)
    .set({ platformApprovedByPlatformUserId: input.approverPlatformUserId })
    .where(eq(supportGrants.id, input.grantId));

  await writePlatformAudit(db, {
    actorPlatformUserId: input.approverPlatformUserId,
    actorLabel: input.actorLabel,
    action: "grant.approved",
    entity: "support_grant",
    entityId: input.grantId,
    after: { tenantId: grant.tenantId, expiresAt: grant.expiresAt },
    ip: input.ip ?? null,
    alsoAuditTenantId: grant.tenantId,
  });
}

export async function revokeGrant(input: {
  grantId: string;
  actorPlatformUserId: string;
  actorLabel: string;
  reason: string;
}): Promise<void> {
  const [grant] = await db.select().from(supportGrants).where(eq(supportGrants.id, input.grantId)).limit(1);
  if (!grant) throw errors.notFound("support_grant", input.grantId);
  await db
    .update(supportGrants)
    .set({ revokedAt: new Date(), revokedReason: input.reason })
    .where(eq(supportGrants.id, input.grantId));
  await writePlatformAudit(db, {
    actorPlatformUserId: input.actorPlatformUserId,
    actorLabel: input.actorLabel,
    action: "grant.revoked",
    entity: "support_grant",
    entityId: input.grantId,
    after: { reason: input.reason },
    alsoAuditTenantId: grant.tenantId,
  });
}

/** Grants for a tenant, newest first (console + tenant audit view). */
export async function listGrants(tenantId?: string, limit = 50) {
  return db
    .select()
    .from(supportGrants)
    .where(tenantId ? eq(supportGrants.tenantId, tenantId) : sql`true`)
    .orderBy(desc(supportGrants.createdAt))
    .limit(limit);
}

/**
 * A live grant = approved by a second person, not revoked, not expired.
 *
 * It is usable by the operator it was requested for, and only by them: the
 * approver approves, they do not browse (four-eyes is not a licence for the
 * approver to read the tenant's books). With no `platformUserId` the newest live
 * grant for the tenant is returned — for listings, never for the access gate.
 */
export async function activeGrant(tenantId: string, platformUserId?: string) {
  const rows = await db
    .select()
    .from(supportGrants)
    .where(
      and(
        eq(supportGrants.tenantId, tenantId),
        isNull(supportGrants.revokedAt),
        gt(supportGrants.expiresAt, new Date()),
        sql`${supportGrants.platformApprovedByPlatformUserId} is not null`,
        platformUserId ? eq(supportGrants.requestedByPlatformUserId, platformUserId) : sql`true`,
      ),
    )
    .orderBy(desc(supportGrants.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * The gate every tenant-data screen in the console must call. Without a live
 * grant the answer is NO — the console simply cannot read tenant books.
 */
export async function assertGrantAccess(input: {
  tenantId: string;
  platformUserId: string;
  screen: string;
  needsAmounts?: boolean;
  needsExport?: boolean;
}): Promise<{ grantId: string }> {
  const grant = await activeGrant(input.tenantId, input.platformUserId);
  if (!grant) {
    throw errors.permission(
      "platform.grant.required",
      `no live support grant for tenant ${input.tenantId} — platform roles have no standing access`,
    );
  }
  const scope = (grant.scope ?? {}) as SupportScope;
  if (!(scope.screens ?? []).includes(input.screen)) {
    throw errors.permission("platform.grant.scope", `grant does not cover screen ${input.screen}`);
  }
  if (input.needsAmounts && !scope.amounts) {
    throw errors.permission("platform.grant.amounts", "grant does not include monetary values");
  }
  if (input.needsExport && !scope.exports) {
    throw errors.permission("platform.grant.export", "grant does not include exports");
  }
  return { grantId: grant.id };
}

/** Count a use of the grant (every read under a grant is auditable). */
export async function recordGrantUse(input: {
  grantId: string;
  screen: string;
  actorLabel: string;
  actorPlatformUserId: string;
  tenantId: string;
  detail?: Record<string, unknown>;
}): Promise<void> {
  await db
    .update(supportGrants)
    .set({ lastUsedAt: new Date(), useCount: sql`${supportGrants.useCount} + 1` })
    .where(eq(supportGrants.id, input.grantId));

  await writePlatformAudit(db, {
    actorPlatformUserId: input.actorPlatformUserId,
    actorLabel: input.actorLabel,
    action: "grant.used",
    entity: "support_grant",
    entityId: input.grantId,
    after: { screen: input.screen, ...input.detail },
    alsoAuditTenantId: input.tenantId,
  });
}

/** Resolve the tenant owner as the recorded tenant-side approver (when available). */
export async function tenantOwnerUserId(tenantId: string): Promise<string | null> {
  const [owner] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.tenantId, tenantId), eq(users.isOwner, true)))
    .limit(1);
  return owner?.id ?? null;
}
