/**
 * Platform operations & data lifecycle (Phase 8 scope: PLATFORM_ADMIN §4/§5,
 * BACKUP_AND_RECOVERY §2).
 *
 * The neighbouring suites prove the boundaries (`platform-admin.test.ts`) and the
 * backup engine (`platform-backup.test.ts`). This one proves the workflows that
 * move tenant data: export bundles, the deletion chain (request → export offer →
 * cooling-off → legal hold → typed confirmation → purge certificate), feature
 * flags, the alert inbox, usage metering, rate limits and settings — and that
 * none of them can be driven without leaving an auditable trace.
 *
 * Runs only when DATABASE_URL is set (environment-limited, TESTING_AND_ACCEPTANCE §2).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync } from "node:fs";
import { sql } from "drizzle-orm";
import { Client } from "pg";

const DB = process.env.DATABASE_URL;
const RUN = Math.random().toString(36).slice(2, 8);
const PLATFORM_EMAIL = `ops.${RUN}@platform.test`;
const PASSWORD = "PlatformPass#2026";
const TENANT_NAME = `مستأجر دورة الحذف ${RUN}`;
const TENANT_OWNER_EMAIL = `owner.${RUN}@lifecycle.test`;

describe.skipIf(!DB)("platform operations — exports, deletion, flags, alerts, limits", () => {
  let db: typeof import("@/db")["db"];
  let tenantsMod: typeof import("@/modules/platform/tenants");
  let exportsMod: typeof import("@/modules/platform/exports");
  let plansMod: typeof import("@/modules/platform/plans");
  let alertsMod: typeof import("@/modules/platform/alerts");
  let settingsMod: typeof import("@/modules/platform/settings");
  let limitsMod: typeof import("@/modules/platform/rate-limit");
  let backupService: typeof import("@/modules/platform/backup/service");
  let identityAuth: typeof import("@/modules/identity/auth");
  let dbContext: typeof import("@/modules/shared/db-context");
  let dates: typeof import("@/modules/shared/dates");

  let platformUserId = "";
  let tenantId = "";
  let tenantOwnerId = "";

  /** Reads used to verify what the application just did run on their own connection. */
  async function verifyRows<T>(text: string, params: unknown[] = []): Promise<T[]> {
    const client = new Client({ connectionString: DB });
    await client.connect();
    try {
      return (await client.query(text, params)).rows as T[];
    } finally {
      await client.end().catch(() => undefined);
    }
  }

  beforeAll(async () => {
    expect(process.env.HISAB_ENCRYPTION_KEY, "platform secrets need an app key").toBeTruthy();
    db = (await import("@/db")).db;
    tenantsMod = await import("@/modules/platform/tenants");
    exportsMod = await import("@/modules/platform/exports");
    plansMod = await import("@/modules/platform/plans");
    alertsMod = await import("@/modules/platform/alerts");
    settingsMod = await import("@/modules/platform/settings");
    limitsMod = await import("@/modules/platform/rate-limit");
    backupService = await import("@/modules/platform/backup/service");
    identityAuth = await import("@/modules/identity/auth");
    dbContext = await import("@/modules/shared/db-context");
    dates = await import("@/modules/shared/dates");

    const { platformUsers, plans } = await import("@/db/schema");
    const planRows = await db.select().from(plans);
    if (planRows.length === 0) {
      await db.insert(plans).values({ code: "starter", name: "Starter", entitlements: {}, priceMonthly: "0" });
    }
    const [me] = await db
      .insert(platformUsers)
      .values({
        email: PLATFORM_EMAIL,
        passwordHash: await identityAuth.hashPassword(PASSWORD),
        name: "Platform Ops Test",
        role: "ops",
      })
      .returning();
    platformUserId = me!.id;

    // A throwaway tenant owns the lifecycle workflows. It is provisioned, not
    // seeded: the purge at the end of this file must be able to remove it without
    // touching any fixture the other suites rely on.
    const provisioned = await tenantsMod.provisionTenant({
      name: TENANT_NAME,
      legalName: `${TENANT_NAME} ذ.م.م`,
      planCode: "starter",
      ownerEmail: TENANT_OWNER_EMAIL,
      ownerName: "Tenant Owner",
      ownerPassword: "TenantOwner#2026",
      actorLabel: "test:provision",
      actorPlatformUserId: platformUserId,
    });
    tenantId = provisioned.tenantId;
    tenantOwnerId = provisioned.ownerUserId;
  }, 180_000);

  afterAll(async () => {
    if (!db) return;
    // Retire the operator account (never hard-delete: the append-only chain keeps
    // the id) and clean up whatever the deletion test could not.
    if (platformUserId) {
      await db
        .execute(sql`delete from sessions where platform_user_id = ${platformUserId}::uuid`)
        .catch(() => undefined);
      await db
        .execute(sql`update platform_users set status = 'disabled' where id = ${platformUserId}::uuid`)
        .catch(() => undefined);
    }
    if (tenantId) {
      const remaining = await verifyRows<{ n: number }>(`select count(*)::int as n from tenants where id = $1`, [
        tenantId,
      ]).catch(() => [{ n: 0 }]);
      if (Number(remaining[0]?.n ?? 0) > 0) {
        const { deleteTenantRows } = await import("@/modules/platform/exports");
        await db.transaction((trx) => deleteTenantRows(trx, tenantId)).catch(() => undefined);
      }
    }
  }, 180_000);

  it("platform export: manifest + per-table checksums, and the download re-verifies the artifact", async () => {
    const built = await exportsMod.buildTenantExport({
      tenantId,
      actorLabel: `test:owner.${RUN}`,
      requestedByUserId: tenantOwnerId,
    });

    expect(built.exportId).toBeTruthy();
    expect(built.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(built.bytes).toBeGreaterThan(0);
    expect(built.tables.length).toBeGreaterThan(10);
    expect(built.tables.every((t) => /^[0-9a-f]{64}$/.test(t.sha256))).toBe(true);
    expect(built.expiresAt.getTime()).toBeGreaterThan(Date.now());

    const rows = await verifyRows<{ status: string; version: number; sha256: string }>(
      `select status, (manifest->>'version')::int as version, sha256 from tenant_exports where id = $1`,
      [built.exportId],
    );
    expect(rows[0]!.status).toBe("ready");
    expect(rows[0]!.version).toBe(1);
    expect(rows[0]!.sha256).toBe(built.sha256);

    const downloaded = await exportsMod.downloadTenantExport({
      exportId: built.exportId,
      token: built.token,
      actorLabel: `test:owner.${RUN}`,
    });
    const bundle = JSON.parse(downloaded.buffer.toString("utf8")) as {
      manifest: { tables: { name: string; rows: number }[] };
      files: Record<string, unknown[]>;
    };
    expect(bundle.manifest.tables.length).toBe(built.tables.length);
    expect(Object.keys(bundle.files).length).toBe(built.tables.length);

    const audit = await verifyRows<{ n: number }>(
      `select count(*)::int as n from platform_audit_log
        where action in ('tenant.exported','tenant.export_downloaded') and entity_id = $1`,
      [built.exportId],
    );
    expect(Number(audit[0]!.n)).toBe(2);
  }, 180_000);

  it("an expired export link is refused and the bundle is marked expired", async () => {
    const built = await exportsMod.buildTenantExport({
      tenantId,
      actorLabel: `test:expiry.${RUN}`,
      requestedByUserId: tenantOwnerId,
    });
    await db.execute(sql`update tenant_exports set expires_at = now() - interval '1 hour' where id = ${built.exportId}::uuid`);

    await expect(
      exportsMod.downloadTenantExport({ exportId: built.exportId, token: built.token, actorLabel: "test:expired" }),
    ).rejects.toMatchObject({ messageKey: "errors.exportExpired" });

    const rows = await verifyRows<{ status: string }>(`select status from tenant_exports where id = $1`, [
      built.exportId,
    ]);
    expect(rows[0]!.status).toBe("expired");
  }, 180_000);

  it("a platform actor cannot build an export without a live grant: standing access does not exist", async () => {
    await expect(
      exportsMod.buildTenantExport({
        tenantId,
        actorLabel: `test:no-grant.${RUN}`,
        requestedByPlatformUserId: platformUserId,
      }),
    ).rejects.toMatchObject({ kind: "PermissionDenied", meta: { permission: "platform.grant.required" } });
  }, 180_000);

  it("feature flags: a global flip takes effect immediately and a tenant override wins", async () => {
    const key = `test_flag_${RUN}`;
    await tenantsMod.setFlag({
      tenantId: null,
      key,
      enabled: true,
      actorLabel: "test:flag",
      actorPlatformUserId: platformUserId,
    });
    expect(await tenantsMod.isFeatureEnabled(tenantId, key)).toBe(true);

    await tenantsMod.setFlag({
      tenantId,
      key,
      enabled: false,
      actorLabel: "test:flag",
      actorPlatformUserId: platformUserId,
    });
    expect(await tenantsMod.isFeatureEnabled(tenantId, key)).toBe(false);
    const flags = await tenantsMod.effectiveFlags(tenantId);
    expect(flags[key]).toBe(false);

    // the override is recorded, not merely applied
    const audit = await verifyRows<{ n: number }>(
      `select count(*)::int as n from platform_audit_log where action = 'flag.changed' and after->>'key' = $1`,
      [key],
    );
    expect(Number(audit[0]!.n)).toBeGreaterThanOrEqual(2);
  }, 60_000);

  it("the alert inbox: raise → acknowledge (with the operator recorded) → resolve", async () => {
    const kind = `test_alert_${RUN}`;
    const id = await alertsMod.raiseAlert({
      severity: "warning",
      kind,
      title: `تنبيه تجريبي ${RUN}`,
      tenantId,
      payload: { source: "test" },
    });
    const before = await alertsMod.countOpenAlerts();
    expect(before.warning + before.critical + before.info).toBeGreaterThan(0);

    await alertsMod.acknowledgeAlert(id, platformUserId);
    const rows = await verifyRows<{ status: string; acknowledged_by: string | null }>(
      `select status, acknowledged_by_platform_user_id::text as acknowledged_by from platform_alerts where id = $1`,
      [id],
    );
    expect(rows[0]!.status).toBe("acknowledged");
    expect(rows[0]!.acknowledged_by).toBe(platformUserId);

    const resolved = await alertsMod.resolveAlerts(kind, tenantId);
    expect(resolved).toBe(1);
    const after = await verifyRows<{ status: string }>(`select status from platform_alerts where id = $1`, [id]);
    expect(after[0]!.status).toBe("resolved");
  }, 60_000);

  it("usage metering counts what the console shows, from the tenant's own rows", async () => {
    const month = dates.todayBusinessDate().slice(0, 7);
    const counts = await plansMod.captureUsageForTenant(tenantId, { day: dates.todayBusinessDate(), month }, (id, fn) =>
      dbContext.withTenant(id, fn),
    );
    expect(counts.users).toBeGreaterThanOrEqual(1);
    expect(counts.invoices_month).toBe(0);

    const stored = await verifyRows<{ metric: string; value: string }>(
      `select metric, value from usage_metrics where tenant_id = $1 and period = $2 order by metric`,
      [tenantId, month],
    );
    expect(stored.length).toBeGreaterThanOrEqual(5);
    const users = stored.find((r) => r.metric === "users");
    expect(Number(users!.value)).toBe(counts.users);
  }, 60_000);

  it("rate limits consume a budget and then block", async () => {
    const key = `test:${RUN}`;
    const seen: boolean[] = [];
    for (let i = 0; i < 25; i += 1) {
      const result = await limitsMod.takeToken("platform-login-ip", key);
      seen.push(result.allowed);
    }
    expect(seen.filter(Boolean).length).toBe(20);
    expect(seen[24]).toBe(false);

    const pruned = await limitsMod.pruneRateLimits();
    expect(pruned).toBeGreaterThanOrEqual(0);
  }, 60_000);

  it("settings round-trip: the retention/support/deletion windows are stored and the change is audited", async () => {
    const before = await settingsMod.getSettings();
    expect(before.supportGrantMaxHours).toBeLessThanOrEqual(24);
    expect(before.backup.keepLatest).toBeGreaterThanOrEqual(18);

    await settingsMod.saveSettings(
      { ...before, backup: { ...before.backup, staleAfterHours: 9 } },
      "test:settings",
    );
    expect((await settingsMod.getSettings()).backup.staleAfterHours).toBe(9);

    // put it back so the live instance keeps the documented threshold
    await settingsMod.saveSettings(before, "test:settings");
    expect((await settingsMod.getSettings()).backup.staleAfterHours).toBe(before.backup.staleAfterHours);

    const audit = await verifyRows<{ n: number }>(
      `select count(*)::int as n from platform_audit_log where action = 'platform.settings_saved'`,
    );
    expect(Number(audit[0]!.n)).toBeGreaterThanOrEqual(2);
  }, 60_000);

  it("the remote transport is labelled honestly: a local contract is not off-site storage", async () => {
    const remote = await backupService.remoteProviderStatus();
    expect(remote.provider).toBe("local-contract");
    expect(remote.configured).toBe(false);
    expect(remote.offsite).toBe(false);
    // only reported "production safe" because this is not production
    expect(remote.productionSafe).toBe(process.env.NODE_ENV !== "production");
  }, 60_000);

  it("deletion: cooling-off, legal hold, an offered export and the typed name all gate the purge — and the purge leaves a certificate, not orphans", async () => {
    const request = await exportsMod.requestDeletion({
      tenantId,
      reason: "test: end of life",
      actorLabel: "test:deletion",
      actorPlatformUserId: platformUserId,
    });
    expect(request.coolingOffUntil.getTime()).toBeGreaterThan(Date.now());

    // nothing is gone yet: the tenant still has all of its history
    const before = await verifyRows<{ users: number; journals: number }>(
      `select (select count(*) from users where tenant_id = $1)::int as users,
              (select count(*) from journal_entries where tenant_id = $1)::int as journals`,
      [tenantId],
    );
    expect(before[0]!.users).toBeGreaterThan(0);

    // 1. a wrong typed confirmation is refused
    await expect(
      exportsMod.purgeTenant({ requestId: request.id, actorLabel: "test:deletion", confirmation: "wrong name" }),
    ).rejects.toMatchObject({ messageKey: "errors.platformTypedConfirmation" });

    // 2. purging without having offered an export is refused
    await expect(
      exportsMod.purgeTenant({ requestId: request.id, actorLabel: "test:deletion", confirmation: TENANT_NAME }),
    ).rejects.toMatchObject({ messageKey: "errors.exportMustBeOffered" });

    // 3. a legal hold outranks everything
    const bundle = await exportsMod.buildTenantExport({
      tenantId,
      actorLabel: "test:deletion",
      requestedByUserId: tenantOwnerId,
    });
    await exportsMod.markExportOffered(request.id, bundle.exportId);
    await exportsMod.setLegalHold({
      requestId: request.id,
      hold: true,
      note: "OQ-8 retention review",
      actorLabel: "test:deletion",
      actorPlatformUserId: platformUserId,
    });
    await expect(
      exportsMod.purgeTenant({ requestId: request.id, actorLabel: "test:deletion", confirmation: TENANT_NAME }),
    ).rejects.toMatchObject({ messageKey: "errors.legalHoldActive" });

    // 4. and while cooling-off is running, still nothing
    await exportsMod.setLegalHold({
      requestId: request.id,
      hold: false,
      actorLabel: "test:deletion",
      actorPlatformUserId: platformUserId,
    });
    await expect(
      exportsMod.purgeTenant({ requestId: request.id, actorLabel: "test:deletion", confirmation: TENANT_NAME }),
    ).rejects.toMatchObject({ messageKey: "errors.coolingOffActive" });

    // cooling-off elapses (the clock is the only thing faked here)
    await db.execute(
      sql`update deletion_requests set cooling_off_until = now() - interval '1 minute' where id = ${request.id}::uuid`,
    );
    const purged = await exportsMod.purgeTenant({
      requestId: request.id,
      actorLabel: "test:deletion",
      actorPlatformUserId: platformUserId,
      confirmation: TENANT_NAME,
    });
    expect(purged.certificate.totalDeleted as number).toBeGreaterThan(0);
    expect(purged.certificate.safetyBackupRunId).toBeTruthy();

    // the bundle is a full copy of the tenant's data: purging the tenant must take
    // its exports with it, or "deleted" would be a claim the disk contradicts
    expect(purged.certificate.exportArtifactsRemoved as number).toBeGreaterThanOrEqual(1);
    expect(existsSync(bundle.path), `export artifact survived the purge: ${bundle.path}`).toBe(false);

    // the tenant is gone, and so is every child row it owned
    const after = await verifyRows<{
      tenants: number;
      users: number;
      customers: number;
      journals: number;
      exports: number;
    }>(
      `select (select count(*) from tenants where id = $1)::int as tenants,
              (select count(*) from users where tenant_id = $1)::int as users,
              (select count(*) from customers where tenant_id = $1)::int as customers,
              (select count(*) from journal_entries where tenant_id = $1)::int as journals,
              (select count(*) from tenant_exports where tenant_id = $1)::int as exports`,
      [tenantId],
    );
    expect(after[0]).toEqual({ tenants: 0, users: 0, customers: 0, journals: 0, exports: 0 });

    const certificate = await verifyRows<{ status: string; certificate: { totalDeleted: number } | null }>(
      `select status, certificate from deletion_requests where id = $1`,
      [request.id],
    );
    expect(certificate[0]!.status).toBe("purged");
    expect(certificate[0]!.certificate!.totalDeleted).toBeGreaterThan(0);

    const audit = await verifyRows<{ action: string }>(
      `select action from platform_audit_log where entity_id = $1 or after->>'tenantId' = $2 order by at`,
      [request.id, tenantId],
    );
    const actions = new Set(audit.map((r) => r.action));
    expect(actions.has("tenant.deletion_requested")).toBe(true);
    expect(actions.has("tenant.purged")).toBe(true);

    // the tenant is gone, so the teardown has nothing left to clean up
    tenantId = "";
  }, 180_000);
});
