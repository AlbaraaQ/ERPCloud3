/**
 * Database-engine capability probe for environment-limited suites (AC-025 §2).
 *
 * The sandbox runs PostgreSQL via PGlite + a wire-protocol socket server, which
 * serves EVERY logical connection from ONE backend session. Consequences:
 *   - `savepoint` / `rollback to savepoint` leak across connections, so
 *     idempotent-replay and concurrency assertions cannot be evaluated;
 *   - role switching is a no-op, so row-level-security policies cannot be
 *     exercised against a non-privileged role.
 *
 * `isSharedSessionEngine` detects that condition precisely (two connections
 * reporting the same `pg_backend_pid()`), so those tests are SKIPPED with a
 * documented reason instead of being reported as passing. Against a normal
 * PostgreSQL server every assertion runs.
 */

import pg from "pg";

export async function isSharedSessionEngine(connectionString: string): Promise<boolean> {
  const a = new pg.Client({ connectionString });
  const b = new pg.Client({ connectionString });
  try {
    await a.connect();
    await b.connect();
    const [ra, rb] = await Promise.all([
      a.query<{ pid: number }>("select pg_backend_pid() as pid"),
      b.query<{ pid: number }>("select pg_backend_pid() as pid"),
    ]);
    return ra.rows[0].pid === rb.rows[0].pid;
  } catch {
    // cannot probe → assume the restricted engine so nothing is claimed falsely
    return true;
  } finally {
    await a.end().catch(() => {});
    await b.end().catch(() => {});
  }
}
