/**
 * Background worker bootstrap (D-013): pg-boss runs in-process with the app.
 * Phase 1 wires the runtime + a heartbeat queue; business queues attach in
 * later phases (backup, reconcile-stock, zatca-retry, notify).
 */

import { PgBoss } from "pg-boss";
import { logger } from "@/modules/shared/logger";

export type WorkerStatus = "starting" | "ready" | "degraded" | "stopped";

interface WorkerGlobal {
  __hisabBoss?: PgBoss;
  __hisabWorkerStatus?: WorkerStatus;
  __hisabWorkerStartedAt?: string;
}
const g = globalThis as typeof globalThis & WorkerGlobal;

export function getWorkerStatus(): { status: WorkerStatus; startedAt: string | null } {
  return { status: g.__hisabWorkerStatus ?? "stopped", startedAt: g.__hisabWorkerStartedAt ?? null };
}

export const HEARTBEAT_QUEUE = "heartbeat";
export const ZATCA_QUEUE = "zatca-submission";
/** Phase 8 platform maintenance queues (BACKUP_AND_RECOVERY §2/§5). */
export const BACKUP_QUEUE = "backup-run";
export const BACKUP_VERIFY_QUEUE = "backup-verify";
export const BACKUP_DRILL_QUEUE = "backup-drill";
export const BACKUP_PRUNE_QUEUE = "backup-prune";
export const PLATFORM_MAINTENANCE_QUEUE = "platform-maintenance";

export async function startWorker(): Promise<void> {
  if (g.__hisabBoss) return;
  if (!process.env.DATABASE_URL) {
    g.__hisabWorkerStatus = "degraded";
    logger.warn("worker: DATABASE_URL missing — running without job queue");
    return;
  }
  if (process.env.ENABLE_WORKER === "false") {
    g.__hisabWorkerStatus = "stopped";
    return;
  }

  g.__hisabWorkerStatus = "starting";
  try {
    const boss = new PgBoss({
      connectionString: process.env.DATABASE_URL,
    });

    boss.on("error", (err) => {
      logger.error({ err }, "pg-boss error");
      g.__hisabWorkerStatus = "degraded";
    });

    await boss.start();
    // Retry policy lives on the queue in pg-boss v12.
    await boss.createQueue(HEARTBEAT_QUEUE, {
      retryLimit: 3,
      retryBackoff: true,
      retryDelay: 30,
      expireInSeconds: 1800,
    });
    await boss.work(HEARTBEAT_QUEUE, async ([job]) => {
      logger.debug({ jobId: job?.id }, "worker heartbeat");
    });
    // keep-alive signal proving the queue pipeline works end to end
    await boss.schedule(HEARTBEAT_QUEUE, "*/15 * * * *", {});

    // --- zatca submissions: process pending/failed e-invoice submissions
    await boss.createQueue(ZATCA_QUEUE, {
      retryLimit: 5,
      retryBackoff: true,
      retryDelay: 60,
      expireInSeconds: 900,
    });
    await boss.work(ZATCA_QUEUE, async () => {
      const { processPendingSubmissions } = await import("@/modules/tax/processor");
      const results = await processPendingSubmissions(20);
      const failed = results.filter((r) => r.outcome === "failed_retryable");
      logger.info(
        { processed: results.length, failedRetryable: failed.length },
        "zatca submission batch done",
      );
      // transport failures throw → pg-boss retries with backoff (same uuid/ICV)
      if (failed.length > 0) {
        throw new Error(`zatca submissions failed (retryable): ${failed.length}`);
      }
    });
    await boss.schedule(ZATCA_QUEUE, "*/5 * * * *", {});

    // --- backups: 4-hourly verified copy, daily re-verification + drill + prune
    await boss.createQueue(BACKUP_QUEUE, {
      retryLimit: 2,
      retryBackoff: true,
      retryDelay: 300,
      // a dump may legitimately take minutes; expire well above the dump timeout
      expireInSeconds: 3600,
    });
    await boss.work(BACKUP_QUEUE, async () => {
      const { runBackup, checkBackupFreshness } = await import("@/modules/platform/backup/service");
      const run = await runBackup({ kind: "scheduled", actorLabel: "worker:backup-run" });
      // freshness is evaluated after every attempt: a stale backup is a BLOCKER
      await checkBackupFreshness();
      logger.info(
        { runId: run.id, status: run.status, bytes: run.artifactBytes, ms: run.durationMs },
        "scheduled backup finished",
      );
      if (run.status !== "verified") {
        throw new Error(`scheduled backup not verified (${run.status})`);
      }
    });
    await boss.schedule(BACKUP_QUEUE, "0 */4 * * *", {});

    await boss.createQueue(BACKUP_VERIFY_QUEUE, {
      retryLimit: 3,
      retryBackoff: true,
      retryDelay: 120,
      expireInSeconds: 1800,
    });
    await boss.work(BACKUP_VERIFY_QUEUE, async () => {
      // re-read the newest verified artifact: catches silent corruption (bit rot)
      const { artifactIntegritySweep, checkBackupFreshness } = await import(
        "@/modules/platform/backup/service"
      );
      const result = await artifactIntegritySweep(5);
      await checkBackupFreshness();
      logger.info(result, "backup integrity sweep");
      if (result.corrupted > 0) throw new Error(`backup integrity sweep found ${result.corrupted} bad artifacts`);
    });
    await boss.schedule(BACKUP_VERIFY_QUEUE, "30 2 * * *", {});

    await boss.createQueue(BACKUP_DRILL_QUEUE, {
      retryLimit: 1,
      retryBackoff: false,
      expireInSeconds: 1800,
    });
    await boss.work(BACKUP_DRILL_QUEUE, async () => {
      const { runRestoreDrill, dropOrphanDrillSchemas } = await import("@/modules/platform/backup/service");
      const drill = await runRestoreDrill({ actorLabel: "worker:restore-drill" });
      await dropOrphanDrillSchemas();
      logger.info(
        { runId: drill.runId, status: drill.status, rows: drill.rows, ms: drill.durationMs },
        "restore drill finished",
      );
      if (drill.status !== "passed") throw new Error("restore drill failed");
    });
    await boss.schedule(BACKUP_DRILL_QUEUE, "0 3 * * 0", {});

    await boss.createQueue(BACKUP_PRUNE_QUEUE, { retryLimit: 2, expireInSeconds: 900 });
    await boss.work(BACKUP_PRUNE_QUEUE, async () => {
      const { pruneBackups } = await import("@/modules/platform/backup/service");
      logger.info(await pruneBackups(), "backup retention applied");
    });
    await boss.schedule(BACKUP_PRUNE_QUEUE, "0 4 * * *", {});

    await boss.createQueue(PLATFORM_MAINTENANCE_QUEUE, { retryLimit: 1, expireInSeconds: 1800 });
    await boss.work(PLATFORM_MAINTENANCE_QUEUE, async () => {
      const { dropOrphanDrillSchemas } = await import("@/modules/platform/backup/service");
      const { pruneRateLimits } = await import("@/modules/platform/rate-limit");
      const { expireExports } = await import("@/modules/platform/exports");
      const { captureUsageForTenant } = await import("@/modules/platform/plans");
      const { resolveAlerts } = await import("@/modules/platform/alerts");
      const { listTenants } = await import("@/modules/platform/tenants");
      const { checkBackupFreshness } = await import("@/modules/platform/backup/service");
      const { purgeExpiredAiConversations } = await import("@/modules/ai/retention");
      const { withTenant } = await import("@/modules/shared/db-context");

      await dropOrphanDrillSchemas();
      const limits = await pruneRateLimits();
      const expired = await expireExports();
      // Daily usage snapshot per tenant (counts only — never amounts). The period
      // keys are UTC; per-tenant timezone keys are a documented refinement.
      const tenants = await listTenants();
      const stamp = new Date().toISOString();
      const day = stamp.slice(0, 10);
      const month = stamp.slice(0, 7);
      for (const tenant of tenants) {
        await captureUsageForTenant(tenant.id, { day, month }, withTenant).catch((err) =>
          logger.warn({ err, tenant: tenant.id }, "usage capture failed"),
        );
      }
      // AI conversation retention (AI_ASSISTANT §5/§7): expired threads go, the
      // tool-call/injection audit and every approval ticket stay. Read-only tenants
      // are reported, not swept — suspension preserves history by design.
      const retention = await purgeExpiredAiConversations();
      await checkBackupFreshness();
      const cleared = await resolveAlerts("worker_heartbeat_stale", null);
      logger.info(
        {
          limits,
          expired,
          tenants: tenants.length,
          cleared,
          aiRetention: {
            swept: retention.length,
            conversations: retention.reduce((a, r) => a + r.conversations, 0),
            skipped: retention.filter((r) => r.skippedReason).length,
          },
        },
        "platform maintenance done",
      );
    });
    await boss.schedule(PLATFORM_MAINTENANCE_QUEUE, "15 1 * * *", {});

    g.__hisabBoss = boss;
    g.__hisabWorkerStatus = "ready";
    g.__hisabWorkerStartedAt = new Date().toISOString();
    logger.info("worker: pg-boss started");
  } catch (err) {
    g.__hisabWorkerStatus = "degraded";
    logger.error({ err }, "worker: failed to start pg-boss");
  }
}

/** Enqueue helper (throws if worker unavailable — callers decide policy). */
export async function enqueue(name: string, data: Record<string, unknown>): Promise<string | null> {
  if (!g.__hisabBoss) throw new Error("job queue unavailable");
  return g.__hisabBoss.send(name, data);
}
