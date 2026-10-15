/**
 * Health endpoint (SYSTEM_ARCHITECTURE §3, BACKUP_AND_RECOVERY §7).
 *
 * Backup freshness is a BLOCKER, not a footnote: an instance whose last verified
 * backup is older than the policy threshold reports `ok: false`. "Never backed
 * up" is treated as a blocker in production and as an open item in dev (a fresh
 * development database has no history yet, and failing closed here would mask
 * real database/worker problems during development).
 */

import { db, pool } from "@/db";
import { sql } from "drizzle-orm";
import { getWorkerStatus } from "@/modules/jobs/worker";
import { backupFreshness } from "@/modules/platform/backup/service";
import { logger } from "@/modules/shared/logger";

export const dynamic = "force-dynamic";

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

  let backup: {
    state: "fresh" | "stale" | "missing";
    lastVerifiedAt: string | null;
    ageHours: number | null;
    thresholdHours: number;
    blocker: boolean;
  } = { state: "missing", lastVerifiedAt: null, ageHours: null, thresholdHours: 0, blocker: false };
  try {
    const fresh = await backupFreshness();
    const state = !fresh.lastVerifiedAt ? "missing" : fresh.stale ? "stale" : "fresh";
    backup = {
      state,
      lastVerifiedAt: fresh.lastVerifiedAt ? fresh.lastVerifiedAt.toISOString() : null,
      ageHours: fresh.ageHours === null ? null : Number(fresh.ageHours.toFixed(2)),
      thresholdHours: fresh.thresholdHours,
      blocker: state === "stale" || (state === "missing" && process.env.NODE_ENV === "production"),
    };
  } catch (err) {
    logger.warn({ err }, "health: backup freshness unavailable");
    backup.blocker = true;
    backup.state = "missing";
  }

  const blockers: string[] = [];
  if (!dbOk) blockers.push("database");
  if (worker.status === "degraded") blockers.push("worker");
  if (backup.blocker) blockers.push(backup.state === "stale" ? "backup_stale" : "backup_missing");

  const ok = blockers.length === 0;

  return Response.json(
    {
      ok,
      db: dbOk,
      worker,
      backup,
      blockers,
      pool: { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount },
      latencyMs: Date.now() - started,
      time: new Date().toISOString(),
      phase: "8-platform",
    },
    { status: ok ? 200 : 503 },
  );
}
