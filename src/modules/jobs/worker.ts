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
