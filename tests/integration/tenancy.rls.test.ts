/**
 * Tenant isolation at the database layer (INV-16, SEC §2 — layer 2 defense).
 * Runs only when DATABASE_URL is set (environment-limited, see
 * TESTING_AND_ACCEPTANCE §2). Uses a dedicated NOBYPASSRLS test role so
 * policies are proven against a non-privileged connection.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";

const DB = process.env.DATABASE_URL;
const TEST_ROLE = "hisab_rls_test";
const TEST_PW = "rls_test_pw_2026";

const admin = DB ? new pg.Pool({ connectionString: DB }) : null;
let tenantA = "";
let tenantB = "";
/** PGlite serves every logical connection from one backend session, so the test
 *  role cannot be assumed independently of the owner: the policy assertions are
 *  skipped there (environment-limited, AC-025 §2) and never reported as passing. */
let sharedSession = true;

async function q(pool: pg.Pool | pg.PoolClient, text: string, params?: unknown[]) {
  return pool.query(text, params);
}

describe.skipIf(!DB)("RLS tenant isolation (db layer)", () => {
  beforeAll(async () => {
    if (!admin) return;
    const tenants = await q(admin, `select id from tenants order by created_at asc limit 2`);
    expect(tenants.rows.length).toBeGreaterThanOrEqual(2);
    tenantA = tenants.rows[0].id;
    tenantB = tenants.rows[1].id;

    const { isSharedSessionEngine } = await import("../helpers/db-engine");
    sharedSession = await isSharedSessionEngine(DB!);

    await q(
      admin,
      `do $$ begin if exists (select 1 from pg_roles where rolname = '${TEST_ROLE}') then
         drop owned by ${TEST_ROLE}; drop role ${TEST_ROLE};
       end if; end $$;`,
    );
    await q(admin, `create role ${TEST_ROLE} login password '${TEST_PW}'`);
    await q(admin, `grant connect on database app_db to ${TEST_ROLE}`);
    await q(admin, `grant usage on schema public to ${TEST_ROLE}`);
    await q(admin, `grant select, insert, update, delete on all tables in schema public to ${TEST_ROLE}`);
    await q(admin, `grant execute on function public.app_tenant_id() to ${TEST_ROLE}`);
  });

  afterAll(async () => {
    if (!admin) return;
    await q(admin, `drop owned by ${TEST_ROLE}`).catch(() => {});
    await q(admin, `drop role if exists ${TEST_ROLE}`).catch(() => {});
    await admin.end();
  });

  function testClient(): pg.Pool {
    const u = new URL(DB!);
    return new pg.Pool({
      host: u.hostname,
      port: Number(u.port || 5432),
      database: decodeURIComponent(u.pathname.replace(/^\//, "")),
      user: TEST_ROLE,
      password: TEST_PW,
    });
  }

  it("without tenant context: zero visibility on tenant tables", async ({ skip }) => {
    if (sharedSession) skip();
    const pool = testClient();
    try {
      const r = await q(pool, `select count(*)::int as n from public.users`);
      expect(r.rows[0].n).toBe(0);
      const t = await q(pool, `select count(*)::int as n from public.tenants`);
      expect(t.rows[0].n).toBe(0);
    } finally {
      await pool.end();
    }
  });

  it("with tenant A: sees only tenant A users", async ({ skip }) => {
    if (sharedSession) skip();
    const pool = testClient();
    try {
      const client = await pool.connect();
      try {
        await q(client, `begin`);
        await q(client, `select set_config('app.tenant_id', $1, true)`, [tenantA]);
        const r = await q(client, `select tenant_id from public.users`);
        expect(r.rows.length).toBeGreaterThan(0);
        expect(new Set(r.rows.map((x) => x.tenant_id)).size).toBe(1);
        expect(r.rows[0].tenant_id).toBe(tenantA);
        await q(client, `commit`);
      } finally {
        client.release();
      }
    } finally {
      await pool.end();
    }
  });

  it("cannot update another tenant's rows (B invisible under A)", async ({ skip }) => {
    if (sharedSession) skip();
    const pool = testClient();
    try {
      const client = await pool.connect();
      try {
        await q(client, `begin`);
        await q(client, `select set_config('app.tenant_id', $1, true)`, [tenantA]);
        const r = await q(client, `update public.users set name = name where tenant_id = $1`, [tenantB]);
        expect(r.rowCount).toBe(0);
        await q(client, `commit`);
      } finally {
        client.release();
      }
    } finally {
      await pool.end();
    }
  });

  it("cannot insert into another tenant (WITH CHECK)", async ({ skip }) => {
    if (sharedSession) skip();
    const pool = testClient();
    try {
      const client = await pool.connect();
      let failed = false;
      try {
        await q(client, `begin`);
        await q(client, `select set_config('app.tenant_id', $1, true)`, [tenantA]);
        await q(
          client,
          `insert into public.users (tenant_id, email, password_hash, name) values ($1, 'rls-break@test', 'x', 'تجربة اختراق')`,
          [tenantB],
        );
      } catch {
        failed = true;
      } finally {
        await q(client, `rollback`).catch(() => {});
        client.release();
      }
      expect(failed).toBe(true);
    } finally {
      await pool.end();
    }
  });

  it("audit_log inserts via write_audit work; direct read is tenant-scoped", async ({ skip }) => {
    if (sharedSession) skip();
    const pool = testClient();
    try {
      const client = await pool.connect();
      try {
        await q(client, `begin`);
        await q(client, `select set_config('app.tenant_id', $1, true)`, [tenantA]);
        await q(
          client,
          `select public.write_audit(gen_random_uuid(), $1::uuid, null, null, 'rls-test', 'test.rls.write', 'test', '1', null, null, null, null)`,
          [tenantA],
        );
        const r = await q(client, `select action from public.audit_log where action = 'test.rls.write'`);
        expect(r.rows.length).toBe(1);
        // hash chain present
        const h = await q(client, `select hash, prev_hash from public.audit_log where tenant_id = $1 order by at desc, id desc limit 2`, [tenantA]);
        expect(h.rows[0].hash).toMatch(/^[0-9a-f]{64}$/);
        if (h.rows.length > 1) {
          expect(h.rows[0].prev_hash).toBe(h.rows[1].hash);
        }
        await q(client, `rollback`); // test artifact cleanup
      } finally {
        client.release();
      }
    } finally {
      await pool.end();
    }
  });
});
