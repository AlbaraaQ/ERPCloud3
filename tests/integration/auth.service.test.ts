/**
 * Auth service integration (environment-limited: needs DATABASE_URL + seed).
 * Proves session lifecycle: create → context w/ permissions → revoke → dead,
 * and expiry enforcement.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { sql } from "drizzle-orm";

const DB = process.env.DATABASE_URL;

describe.skipIf(!DB)("auth service — session lifecycle", () => {
  let db: typeof import("@/db")["db"];
  let ownerId = "";
  let tenantId = "";

  beforeAll(async () => {
    ({ db } = await import("@/db"));
    const res = await db.execute(
      sql`select u.id as user_id, u.tenant_id from public.users u join public.tenants t on t.id = u.tenant_id where u.email = 'owner@horizon.test' limit 1`,
    );
    const rows = (res as unknown as { rows: { user_id: string; tenant_id: string }[] }).rows;
    expect(rows.length).toBe(1);
    ownerId = rows[0].user_id;
    tenantId = rows[0].tenant_id;
  });

  it("creates a session and resolves full context with tenant + permissions", async () => {
    const { createSession, buildContextByToken } = await import("@/modules/identity/auth");
    const { token } = await createSession({ userId: ownerId, tenantId, ip: "127.0.0.1", userAgent: "vitest" });

    const ctx = await buildContextByToken(token);
    expect(ctx).not.toBeNull();
    expect(ctx!.tenant!.id).toBe(tenantId);
    expect(ctx!.userEmail).toBe("owner@horizon.test");
    expect(ctx!.roles).toContain("tenant_owner");
    expect(ctx!.permissions.has("settings.roles.manage")).toBe(true);
    expect(ctx!.permissions.has("platform.tenants.manage")).toBe(false);
  });

  it("rejects unknown and revoked tokens", async () => {
    const { createSession, buildContextByToken, revokeSession } = await import("@/modules/identity/auth");

    expect(await buildContextByToken("not-a-real-token")).toBeNull();

    const { token } = await createSession({ userId: ownerId, tenantId });
    const ctx = await buildContextByToken(token);
    expect(ctx).not.toBeNull();
    await revokeSession(ctx!.session.id);
    expect(await buildContextByToken(token)).toBeNull();
  });

  it("rejects expired sessions", async () => {
    const { createSession, buildContextByToken } = await import("@/modules/identity/auth");
    const { sessions } = await import("@/db/schema");
    const { eq } = await import("drizzle-orm");

    const { token } = await createSession({ userId: ownerId, tenantId });
    const ctx = await buildContextByToken(token);
    expect(ctx).not.toBeNull();

    await db.execute(sql`update public.sessions set expires_at = now() - interval '1 minute' where id = ${ctx!.session.id}::uuid`);
    expect(await buildContextByToken(token)).toBeNull();

    await db.delete(sessions).where(eq(sessions.id, ctx!.session.id));
  });
});
