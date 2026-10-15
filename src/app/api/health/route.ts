import { db, pool } from "@/db";
import { sql } from "drizzle-orm";
import { getWorkerStatus } from "@/modules/jobs/worker";

export const dynamic = "force-dynamic";

/** Health: db connectivity + worker status. Extended per phase (SYSTEM_ARCHITECTURE §3). */
export async function GET() {
  const started = Date.now();
  let dbOk = false;
  try {
    await db.execute(sql`select 1`);
    dbOk = true;
  } catch {
    dbOk = false;
  }

  const worker = getWorkerStatus();
  const ok = dbOk && worker.status !== "degraded";

  return Response.json(
    {
      ok,
      db: dbOk,
      worker,
      pool: { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount },
      latencyMs: Date.now() - started,
      time: new Date().toISOString(),
      phase: "1-foundation",
    },
    { status: ok ? 200 : 500 },
  );
}
