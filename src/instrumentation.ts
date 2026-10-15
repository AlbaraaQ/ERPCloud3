/**
 * Next.js instrumentation hook — starts the in-process job worker with the
 * server runtime (not during build). See docs/SYSTEM_ARCHITECTURE §3.
 */

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startWorker } = await import("@/modules/jobs/worker");
    await startWorker();
  }
}
