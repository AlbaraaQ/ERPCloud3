/**
 * Backup/restore operator script (BACKUP_AND_RECOVERY §3/§5/§6).
 *
 * The worker schedules these operations in a normal deployment; here (and in any
 * environment without LISTEN/NOTIFY) they run on demand so the same code path can
 * be exercised and its evidence inspected:
 *
 *   npx tsx scripts/platform-backup.mts run [--no-remote] [--format=logical-json]
 *   npx tsx scripts/platform-backup.mts verify <runId|latest>
 *   npx tsx scripts/platform-backup.mts drill [runId] [--keep]
 *   npx tsx scripts/platform-backup.mts prune
 *   npx tsx scripts/platform-backup.mts status
 */

import "dotenv/config";
import { runBackup, verifyBackup, runRestoreDrill, pruneBackups, backupFreshness, listBackupRuns, remoteProviderStatus } from "@/modules/platform/backup/service";
import { sql } from "drizzle-orm";
import { db, pool } from "@/db";

const [command = "status", ...rest] = process.argv.slice(2);
const flags = new Set(rest.filter((a) => a.startsWith("--")));
const positional = rest.filter((a) => !a.startsWith("--"));
const formatFlag = rest.find((a) => a.startsWith("--format="))?.split("=")[1] as
  | "auto"
  | "pg_dump-custom"
  | "logical-json"
  | undefined;

function line(label: string, value: unknown) {
  console.log(`${label.padEnd(22)} ${typeof value === "object" ? JSON.stringify(value) : String(value)}`);
}

async function resolveRunId(arg: string | undefined): Promise<string | undefined> {
  if (!arg || arg === "latest") return undefined;
  return arg;
}

try {
  switch (command) {
    case "run": {
      const started = Date.now();
      const result = await runBackup({
        kind: "manual",
        actorLabel: `cli:${process.env.USER ?? "operator"}`,
        skipRemote: flags.has("--no-remote"),
        format: formatFlag,
      });
      line("run id", result.id);
      line("status", result.status);
      line("format", result.format);
      line("database", result.databaseName);
      line("tables / rows", `${result.tables} / ${result.rows}`);
      line("plaintext bytes", result.plaintextBytes);
      line("artifact bytes", result.artifactBytes);
      line("plaintext sha256", result.plaintextSha256);
      line("artifact sha256", result.artifactSha256);
      line("artifact path", result.artifactPath);
      line("remote provider", result.remoteProvider ?? "(none — local only)");
      line("remote verified", result.remoteVerified);
      line("duration ms", result.durationMs);
      if (result.errorClass) line("error", `${result.errorClass}: ${result.errorDetail}`);
      console.log(
        result.status === "verified"
          ? "\n✓ verified: the artifact decrypts and every table reproduces its row count and content hash"
          : "\n✗ NOT verified — this run must not be treated as a usable backup",
      );
      console.log(`wall clock ${Date.now() - started} ms`);
      break;
    }

    case "verify": {
      const runId = await resolveRunId(positional[0]);
      const target =
        runId ?? (await listBackupRuns(1))[0]?.id ?? (() => {
          throw new Error("no backup run to verify");
        })();
      const result = await verifyBackup(target);
      line("run id", result.id);
      line("status", result.status);
      for (const check of result.checks) {
        line(`  ${check.skipped ? "○" : check.ok ? "✓" : "✗"} ${check.name}`, check.detail);
      }
      break;
    }

    case "drill": {
      const result = await runRestoreDrill({
        runId: await resolveRunId(positional[0]),
        actorLabel: `cli:${process.env.USER ?? "operator"}`,
        keepSchema: flags.has("--keep"),
      });
      line("source run", result.runId);
      line("target schema", result.schema);
      line("status", result.status);
      line("tables / rows", `${result.tables} / ${result.rows}`);
      line("duration ms", result.durationMs);
      console.log("\ninvariants:");
      for (const check of result.invariants?.checks ?? []) {
        console.log(`  ${check.skipped ? "○" : check.ok ? "✓" : "✗"} ${check.name.padEnd(20)} ${check.detail}`);
      }
      if (result.error) line("error", result.error);
      console.log(
        result.status === "passed"
          ? `\n✓ restore drill passed — the backup restores and the invariants hold (RTO ≈ ${(result.durationMs / 1000).toFixed(1)} s)`
          : "\n✗ restore drill FAILED — the backup is not provably restorable",
      );
      break;
    }

    case "prune": {
      line("retention", await pruneBackups());
      break;
    }

    case "status": {
      const freshness = await backupFreshness();
      line("last verified", freshness.lastVerifiedAt?.toISOString() ?? "(never)");
      line("age hours", freshness.ageHours === null ? "(n/a)" : freshness.ageHours.toFixed(2));
      line("threshold hours", freshness.thresholdHours);
      line("stale", freshness.stale);
      line("verified runs", freshness.verifiedCount);
      line("last run status", freshness.lastRunStatus ?? "(none)");
      line("remote", await remoteProviderStatus());
      const version = (await db.execute(sql`select version() as v`)) as unknown as { rows: { v: string }[] };
      line("engine", String(version.rows[0]?.v ?? "").slice(0, 60));
      console.log("\nrecent runs:");
      for (const run of await listBackupRuns(8)) {
        console.log(
          `  ${run.startedAt.toISOString()}  ${run.status.padEnd(9)} ${run.format.padEnd(15)} ${String(run.artifactBytes ?? "-").padStart(9)} B  drill=${run.drillStatus ?? "-"}`,
        );
      }
      break;
    }

    default:
      console.error(`unknown command: ${command}`);
      process.exitCode = 1;
  }
} catch (err) {
  console.error("\n✗ failed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await pool.end().catch(() => undefined);
}
