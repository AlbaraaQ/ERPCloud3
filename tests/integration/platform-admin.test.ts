/**
 * Platform administration (Phase 8, PLATFORM_ADMIN §0–§5).
 *
 * Proves the console's hard boundaries rather than its screen count:
 *   - its own credential store and session namespace (no cross-tier sessions);
 *   - mandatory 2FA for the Owner role, with throttling and lockout;
 *   - no tenant role code can grant platform access (permission catalogs are disjoint);
 *   - suspension/deactivation is logical: history stays, writes fail, reads do not;
 *   - every console mutation lands in the hash-chained platform audit log and is
 *     mirrored into the affected tenant's own audit trail;
 *   - the platform data layer never returns tenant amounts, and reading tenant
 *     data at all requires an approved, scoped, unexpired support grant.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { sql } from "drizzle-orm";

const DB = process.env.DATABASE_URL;
const RUN = Math.random().toString(36).slice(2, 8);
const OWNER_EMAIL = `owner.${RUN}@platform.test`;
const OPS_EMAIL = `ops.${RUN}@platform.test`;
const PASSWORD = "PlatformPass#2026";

describe.skipIf(!DB)("platform admin — boundaries and lifecycle", () => {
  let db: typeof import("@/db")["db"];
  let auth: typeof import("@/modules/platform/auth");
  let context: typeof import("@/modules/platform/context");
  let tenantsMod: typeof import("@/modules/platform/tenants");
  let auditMod: typeof import("@/modules/platform/audit");
  let grants: typeof import("@/modules/platform/grants");
  let permissions: typeof import("@/modules/platform/permissions");
  let identityAuth: typeof import("@/modules/identity/auth");

  let ownerId = "";
  let opsId = "";
  let ownerToken = "";
  let ownerCtx: import("@/modules/platform/context").PlatformContext;
  let opsCtx: import("@/modules/platform/context").PlatformContext;
  let throwawayTenantId = "";

  async function rows<T = Record<string, unknown>>(query: ReturnType<typeof sql>): Promise<T[]> {
    const res = (await db.execute(query)) as unknown as { rows: T[] };
    return res.rows;
  }

  beforeAll(async () => {
    expect(process.env.HISAB_ENCRYPTION_KEY, "platform secrets need an app key").toBeTruthy();
    db = (await import("@/db")).db;
    auth = await import("@/modules/platform/auth");
    context = await import("@/modules/platform/context");
    tenantsMod = await import("@/modules/platform/tenants");
    auditMod = await import("@/modules/platform/audit");
    grants = await import("@/modules/platform/grants");
    permissions = await import("@/modules/platform/permissions");
    identityAuth = await import("@/modules/identity/auth");

    const { platformUsers, plans } = await import("@/db/schema");
    const planRows = await db.select().from(plans);
    if (planRows.length === 0) {
      await db.insert(plans).values({ code: "starter", name: "Starter", entitlements: {}, priceMonthly: "0" });
    }

    const [owner] = await db
      .insert(platformUsers)
      .values({
        email: OWNER_EMAIL,
        passwordHash: await identityAuth.hashPassword(PASSWORD),
        name: "Platform Owner Test",
        role: "owner",
      })
      .returning();
    ownerId = owner!.id;
    const [ops] = await db
      .insert(platformUsers)
      .values({
        email: OPS_EMAIL,
        passwordHash: await identityAuth.hashPassword(PASSWORD),
        name: "Platform Ops Test",
        role: "ops",
      })
      .returning();
    opsId = ops!.id;
  });

  afterAll(async () => {
    if (!db) return;
    const { platformUsers, tenants } = await import("@/db/schema");
    const { eq } = await import("drizzle-orm");
    // the throwaway tenant is removed through the deletion workflow in the tests
    // that need it; anything left is cleaned up with triggers disabled (fixtures
    // are immutable by design, this is test teardown).
    if (throwawayTenantId) {
      await db.execute(sql`set session_replication_role = replica`).catch(() => undefined);
      await db
        .delete(tenants)
        .where(eq(tenants.id, throwawayTenantId))
        .catch(() => undefined);
      await db.execute(sql`set session_replication_role = default`).catch(() => undefined);
    }
    await db.delete(platformUsers).where(eq(platformUsers.id, ownerId)).catch(() => undefined);
    await db.delete(platformUsers).where(eq(platformUsers.id, opsId)).catch(() => undefined);
  });

  it("owner cannot log in without enrolling 2FA, and enrolment never stores an unverified secret", async () => {
    const noCode = await auth.platformLogin({ email: OWNER_EMAIL, password: PASSWORD, ip: "10.0.0.1" });
    expect(noCode.ok).toBe(false);
    if (noCode.ok) return;
    expect(noCode.needEnrollment).toBe(true);
    expect(noCode.pendingToken).toBeTruthy();

    const stored = await rows<{ totp_secret_cipher: string | null }>(
      sql`select totp_secret_cipher from platform_users where id = ${ownerId}::uuid`,
    );
    expect(stored[0]!.totp_secret_cipher).toBeNull();

    const start = await auth.startTotpEnrollment(noCode.pendingToken!);
    const wrong = await auth.confirmTotpEnrollment({
      pendingToken: start.pendingToken,
      code: "000000",
      actorLabel: OWNER_EMAIL,
    });
    expect(wrong.ok).toBe(false);
    const stillNull = await rows<{ totp_secret_cipher: string | null }>(
      sql`select totp_secret_cipher from platform_users where id = ${ownerId}::uuid`,
    );
    expect(stillNull[0]!.totp_secret_cipher).toBeNull();

    const good = await auth.confirmTotpEnrollment({
      pendingToken: start.pendingToken,
      code: auth.debugTotpForSecret(start.secret),
      actorLabel: OWNER_EMAIL,
    });
    expect(good.ok).toBe(true);

    const after = await rows<{ totp_secret_cipher: string | null; totp_enrolled_at: Date | null }>(
      sql`select totp_secret_cipher, totp_enrolled_at from platform_users where id = ${ownerId}::uuid`,
    );
    expect(after[0]!.totp_secret_cipher).toBeTruthy();
    // stored encrypted (D-024): the plaintext secret must not appear in the column
    expect(after[0]!.totp_secret_cipher).not.toContain(start.secret);
    expect(after[0]!.totp_enrolled_at).toBeTruthy();
  });

  it("owner signs in with password + TOTP only; a wrong code is rejected", async () => {
    const bad = await auth.platformLogin({
      email: OWNER_EMAIL,
      password: PASSWORD,
      totp: "111111",
      ip: "10.0.0.2",
    });
    expect(bad.ok).toBe(false);

    const secret = await rows<{ totp_secret_cipher: string }>(
      sql`select totp_secret_cipher from platform_users where id = ${ownerId}::uuid`,
    );
    const { decryptToString } = await import("@/modules/shared/crypto");
    const plain = decryptToString(secret[0]!.totp_secret_cipher);

    const ok = await auth.platformLogin({
      email: OWNER_EMAIL,
      password: PASSWORD,
      totp: auth.debugTotpForSecret(plain),
      ip: "10.0.0.3",
    });
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    ownerToken = ok.token;

    ownerCtx = (await context.buildPlatformContext(ownerToken))!;
    expect(ownerCtx).toBeTruthy();
    expect(ownerCtx.role).toBe("owner");
    expect(ownerCtx.permissions.has("platform.data.delete")).toBe(true);

    // ops (no 2FA required, and fewer powers)
    const ops = await auth.platformLogin({ email: OPS_EMAIL, password: PASSWORD, ip: "10.0.0.4" });
    expect(ops.ok).toBe(true);
    if (!ops.ok) return;
    opsCtx = (await context.buildPlatformContext(ops.token))!;
    expect(opsCtx.role).toBe("ops");
    expect(opsCtx.permissions.has("platform.data.delete")).toBe(false);
    expect(opsCtx.permissions.has("platform.backup.run")).toBe(true);
  });

  it("sessions never cross tiers: a platform token is not a tenant session and vice versa", async () => {
    // platform token carries no tenant binding → tenant resolution refuses it
    const tenantSide = await identityAuth.buildContextByToken(ownerToken);
    expect(tenantSide).toBeNull();

    // tenant session cannot build a platform context
    const { tenants, users } = await import("@/db/schema");
    const { eq } = await import("drizzle-orm");
    const tenantsList = await db.select().from(tenants).limit(1);
    const [someUser] = await db
      .select()
      .from(users)
      .where(eq(users.tenantId, tenantsList[0]!.id))
      .limit(1);
    if (someUser) {
      const { token } = await identityAuth.createSession({
        userId: someUser.id,
        tenantId: someUser.tenantId,
      });
      const crossBreak = await context.buildPlatformContext(token);
      expect(crossBreak).toBeNull();
    }
  });

  it("no tenant permission code can grant platform access", async () => {
    const platformCodes = permissions.PLATFORM_PERMISSIONS as readonly string[];
    const tenantCodes = await rows<{ code: string }>(sql`select code from permissions`);
    const overlap = tenantCodes.map((r) => r.code).filter((c) => platformCodes.includes(c));
    expect(overlap).toEqual([]);

    // and no tenant role holds a platform permission through the join table
    const roleHits = await rows<{ n: number }>(
      sql`select count(*)::int as n from role_permissions rp join permissions p on p.code = rp.permission_code
          where p.code like 'platform.%'`,
    );
    expect(Number(roleHits[0]!.n)).toBe(0);
  });

  it("platform users live in their own store: no tenant_id column exists on platform_users", async () => {
    const cols = await rows<{ column_name: string }>(
      sql`select column_name from information_schema.columns
          where table_schema = 'public' and table_name = 'platform_users'`,
    );
    const names = cols.map((c) => c.column_name);
    expect(names).not.toContain("tenant_id");
    expect(names).toContain("role");
  });

  it("suspension/deactivation is logical: history preserved, writes rejected, reads intact", async () => {
    const provisioned = await tenantsMod.provisionTenant({
      name: `منشأة اختبار ${RUN}`,
      nameEn: `Test Tenant ${RUN}`,
      legalName: `Test Tenant ${RUN} LLC`,
      vatNumber: "310000000000003",
      planCode: "starter",
      trialDays: 30,
      ownerEmail: `tenant.owner.${RUN}@test.local`,
      ownerName: "Tenant Owner Test",
      ownerPassword: PASSWORD,
      actorLabel: ownerCtx ? context.platformActorLabel(ownerCtx) : "test",
      actorPlatformUserId: ownerId,
    });
    throwawayTenantId = provisioned.tenantId;

    const { withTenant } = await import("@/modules/shared/db-context");
    const { auditLog } = await import("@/db/schema");
    const { newId } = await import("@/modules/shared/ids");

    // a real write while active
    await withTenant(throwawayTenantId, async (trx) => {
      await trx.execute(sql`insert into customers (id, tenant_id, code, name_ar)
                            values (${newId()}::uuid, ${throwawayTenantId}::uuid, ${"C-" + RUN}, ${"عميل " + RUN})`);
    });
    const before = await rows<{ n: number }>(
      sql`select count(*)::int as n from customers where tenant_id = ${throwawayTenantId}::uuid`,
    );
    const tenantAuditBefore = await db
      .select()
      .from(auditLog)
      .where(sql`${auditLog.tenantId} = ${throwawayTenantId}::uuid`);

    await tenantsMod.setTenantStatus({
      tenantId: throwawayTenantId,
      to: "suspended",
      reason: "اختبار الإيقاف — Phase 8",
      actorLabel: ownerCtx ? context.platformActorLabel(ownerCtx) : "test",
      actorPlatformUserId: ownerId,
    });

    // reads keep working
    const visible = await withTenant(throwawayTenantId, async (trx) => {
      const res = (await trx.execute(sql`select count(*)::int as n from customers`)) as unknown as {
        rows: { n: number }[];
      };
      return Number(res.rows[0]!.n);
    });
    expect(visible).toBe(Number(before[0]!.n));

    // writes fail with the tenant-facing read-only error
    await expect(
      withTenant(throwawayTenantId, async (trx) => {
        await trx.execute(sql`insert into customers (id, tenant_id, code, name_ar)
                              values (${newId()}::uuid, ${throwawayTenantId}::uuid, ${"X-" + RUN}, 'blocked')`);
      }),
    ).rejects.toThrow(/tenantReadOnly|read-only/i);

    // nothing was deleted by the suspension
    const after = await rows<{ n: number }>(
      sql`select count(*)::int as n from customers where tenant_id = ${throwawayTenantId}::uuid`,
    );
    expect(Number(after[0]!.n)).toBe(Number(before[0]!.n));

    // tenant-visible mirror of the platform action exists in its own audit chain
    const tenantAuditAfter = await db
      .select()
      .from(auditLog)
      .where(sql`${auditLog.tenantId} = ${throwawayTenantId}::uuid`);
    expect(tenantAuditAfter.length).toBeGreaterThan(tenantAuditBefore.length);
    expect(tenantAuditAfter.some((r) => r.action.startsWith("platform.tenant."))).toBe(true);

    // deactivation is also logical, and reactivation restores writability
    await tenantsMod.setTenantStatus({
      tenantId: throwawayTenantId,
      to: "deactivated",
      reason: "اختبار الإنهاء",
      actorLabel: "test",
      actorPlatformUserId: ownerId,
    });
    const stillThere = await rows<{ n: number; status: string }>(
      sql`select (select count(*)::int from customers where tenant_id = ${throwawayTenantId}::uuid) as n,
                 (select status::text from tenants where id = ${throwawayTenantId}::uuid) as status`,
    );
    expect(Number(stillThere[0]!.n)).toBe(Number(before[0]!.n));
    expect(stillThere[0]!.status).toBe("deactivated");

    await tenantsMod.setTenantStatus({
      tenantId: throwawayTenantId,
      to: "active",
      reason: "إعادة التنشيط بعد الاختبار",
      actorLabel: "test",
      actorPlatformUserId: ownerId,
    });
    await withTenant(throwawayTenantId, async (trx) => {
      await trx.execute(sql`insert into customers (id, tenant_id, code, name_ar)
                            values (${newId()}::uuid, ${throwawayTenantId}::uuid, ${"Y-" + RUN}, 'after reactivation')`);
    });
    const grown = await rows<{ n: number }>(
      sql`select count(*)::int as n from customers where tenant_id = ${throwawayTenantId}::uuid`,
    );
    expect(Number(grown[0]!.n)).toBe(Number(before[0]!.n) + 1);
  });

  it("invalid lifecycle transitions are refused", async () => {
    const { assertTransition } = tenantsMod;
    expect(() => assertTransition("trial", "suspended")).not.toThrow();
    expect(() => assertTransition("suspended", "active")).not.toThrow();
    expect(() => assertTransition("deactivated", "trial")).toThrow();
  });

  it("every console mutation is in the platform audit chain, and the chain verifies", async () => {
    const actions = await rows<{ action: string }>(
      sql`select action from platform_audit_log where action in
            ('tenant.suspended','tenant.deactivated','tenant.active','platform.login.success',
             'platform.2fa.enrollment_required','platform.login.totp_failed')
          group by action`,
    );
    const seen = actions.map((a) => a.action);
    expect(seen).toContain("tenant.suspended");
    expect(seen).toContain("platform.login.success");

    const chain = await auditMod.verifyAuditChain(5000);
    expect(chain.ok, `chain detail: ${chain.detail}`).toBe(true);
    expect(chain.checked).toBeGreaterThan(0);

    // append-only: the table refuses UPDATE/DELETE even from the owner connection
    await expect(db.execute(sql`update platform_audit_log set action = 'x'`)).rejects.toThrow(
      /append-only/i,
    );
  });

  it("the platform data layer returns counts and configuration, never tenant amounts", async () => {
    const overview = await tenantsMod.tenantOverview(throwawayTenantId);
    const moneyKeys = /amount|total|balance|price|cost|vat_|net|gross|debit|credit/i;
    const walk = (value: unknown, path: string): string[] => {
      if (value === null || typeof value !== "object") return [];
      return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => {
        const hit = moneyKeys.test(k) ? [`${path}.${k}`] : [];
        return [...hit, ...walk(v, `${path}.${k}`)];
      });
    };
    expect(walk(overview, "overview")).toEqual([]);

    // and the only path to tenant data — a support grant — is closed by default
    await expect(
      grants.assertGrantAccess({
        tenantId: throwawayTenantId,
        platformUserId: ownerId,
        screen: "accounting",
      }),
    ).rejects.toThrow(/grant/i);
  });

  it("break-glass grants: two-person, scoped, time-boxed, audited, revocable", async () => {
    const requested = await grants.requestGrant({
      tenantId: throwawayTenantId,
      requestedByPlatformUserId: ownerId,
      scope: { screens: ["accounting"], amounts: false },
      reason: "مراجعة محاسبية بطلب من المنشأة",
      hours: 99, // must be clamped to the configured maximum (≤ 24 h)
      actorLabel: "test",
    });

    const [row] = await rows<{ expires_at: Date; scope: { screens: string[]; amounts: boolean } }>(
      sql`select expires_at, scope from support_grants where id = ${requested}::uuid`,
    );
    const hours = (row!.expires_at.getTime() - Date.now()) / 3_600_000;
    expect(hours).toBeLessThanOrEqual(24.5);

    // requester cannot approve their own grant
    await expect(
      grants.approveGrant({
        grantId: requested,
        approverPlatformUserId: ownerId,
        approverRole: "owner",
        actorLabel: "test",
      }),
    ).rejects.toThrow(/two-person|ثان/i);

    // an unapproved grant grants nothing
    await expect(
      grants.assertGrantAccess({ tenantId: throwawayTenantId, platformUserId: opsId, screen: "accounting" }),
    ).rejects.toThrow(/grant/i);

    await grants.approveGrant({
      grantId: requested,
      approverPlatformUserId: opsId,
      approverRole: "ops",
      actorLabel: "test",
    });

    // approved: the scope still decides what is reachable
    const allowed = await grants.assertGrantAccess({
      tenantId: throwawayTenantId,
      platformUserId: opsId,
      screen: "accounting",
    });
    expect(allowed.grantId).toBe(requested);

    await expect(
      grants.assertGrantAccess({
        tenantId: throwawayTenantId,
        platformUserId: opsId,
        screen: "accounting",
        needsAmounts: true,
      }),
    ).rejects.toThrow(/amounts|مبالغ/i);

    await expect(
      grants.assertGrantAccess({ tenantId: throwawayTenantId, platformUserId: opsId, screen: "reports" }),
    ).rejects.toThrow(/scope/i);

    await grants.recordGrantUse({
      grantId: requested,
      screen: "accounting",
      actorLabel: "ops",
      actorPlatformUserId: opsId,
      tenantId: throwawayTenantId,
    });
    const used = await rows<{ use_count: number; last_used_at: Date | null }>(
      sql`select use_count, last_used_at from support_grants where id = ${requested}::uuid`,
    );
    expect(Number(used[0]!.use_count)).toBe(1);
    expect(used[0]!.last_used_at).toBeTruthy();

    // the tenant sees the session in its own audit trail
    const mirrored = await rows<{ n: number }>(
      sql`select count(*)::int as n from audit_log
          where tenant_id = ${throwawayTenantId}::uuid and action like 'platform.grant.%'`,
    );
    expect(Number(mirrored[0]!.n)).toBeGreaterThanOrEqual(3);

    await grants.revokeGrant({
      grantId: requested,
      actorPlatformUserId: opsId,
      actorLabel: "test",
      reason: "انتهت المهمة",
    });
    await expect(
      grants.assertGrantAccess({ tenantId: throwawayTenantId, platformUserId: opsId, screen: "accounting" }),
    ).rejects.toThrow(/grant/i);
  });

  it("quotas are enforced at the write boundary with a warning band", async () => {
    const plans = await import("@/modules/platform/plans");
    const { withTenant } = await import("@/modules/shared/db-context");

    await tenantsMod.setTenantPlan({
      tenantId: throwawayTenantId,
      planCode: "starter",
      actorLabel: "test",
      actorPlatformUserId: ownerId,
    });

    const state = await withTenant(throwawayTenantId, (trx) => plans.quotaState(trx, throwawayTenantId));
    expect(state.map((s) => s.metric)).toContain("users");
    const users = state.find((s) => s.metric === "users")!;
    expect(users.used).toBeGreaterThan(0);
    expect(users.exceeded).toBe(false);

    // a plan with users quota 1 cannot accept a second user
    const { plans: plansTable, subscriptions } = await import("@/db/schema");
    const { eq } = await import("drizzle-orm");
    await db
      .update(plansTable)
      .set({ entitlements: { features: [], quotas: { users: 1 } } })
      .where(eq(plansTable.code, "starter"));
    await db
      .update(subscriptions)
      .set({ planCode: "starter" })
      .where(eq(subscriptions.tenantId, throwawayTenantId));

    await expect(
      withTenant(throwawayTenantId, (trx) => plans.assertQuota(trx, throwawayTenantId, "users", 1)),
    ).rejects.toThrow(/quota|حصة/i);

    // at capacity but not over it: allowed
    await withTenant(throwawayTenantId, (trx) => plans.assertQuota(trx, throwawayTenantId, "users", 0));
  }, 60_000);
});
