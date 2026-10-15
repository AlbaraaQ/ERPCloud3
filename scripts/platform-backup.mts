/**
 * Platform backup CLI (ops tool + the sandbox's job runner).
 *
 *   npx tsx scripts/platform-backup.mts run [--no-remote] [--only t1,t2]
 *   npx tsx scripts/platform-backup.mts list
 *   npx tsx scripts/platform-backup.mts verify <runId>
 *   npx tsx scripts/platform-backup.mts drill [runId] [--keep]
 *   npx tsx scripts/platform-backup.mts prune
 *   npx tsx scripts/platform-backup.mts freshness
 *
 * The dev sandbox has no pg-boss schedule (ENABLE_WORKER=false in .env), so this
 * is how the 4-hourly job is invoked by hand here; in production the same
 * functions run from the `backup` queue in src/modules/jobs/worker.ts.
 */

import "dotenv/config";
import {
  artifactInventory,
  backupFreshness,
  listBackupRuns,
  pruneBackups,
  runBackup,
  runRestoreDrill,
  verifyBackup,
} from "@/modules/platform/backup/service";

const [command, ...rest] = process.argv.slice(2);
const flags = new Set(rest.filter((r) => r.startsWith("--")));
const args = rest.filter((r) => !r.startsWith("--"));
const onlyArg = rest.find((r) => r.startsWith("--only"));
const only = onlyArg ? onlyArg.split("=")[1]?.split(",").filter(Boolean) : undefined;

function stamp(date: Date | null | undefined): string {
  return date ? date.toISOString().replace("T", " ").slice(0, 19) : "—";
}

async function main() {
  switch (command) {
    case "run": {
      const result = await runBackup({
        kind: "manual",
        actorLabel: "cli/platform-backup",
        skipRemote: flags.has("--no-remote"),
        onlyTables: only,
      });
      console.log(JSON.stringify(result, null, 2));
      if (result.status !== "verified") process.exitCode = 1;
      break;
    }
    case "list": {
      for (const row of await listBackupRuns(20)) {
        console.log(
          `${row.id.slice(0, 8)}  ${stamp(row.startedAt)}  ${row.status.padEnd(9)} ${row.format.padEnd(14)} ` +
            `${String(row.artifactBytes ?? 0).padStart(10)}B  remote=${row.remoteProvider ?? "—"}  ${row.errorClass ?? ""}`,
        );
      }
      const inv = await artifactInventory();
      console.log(`artifacts on disk: ${inv.files.length} (orphans: ${inv.orphans.length})`);
      break;
    }
    case "verify": {
      const id = args[0];
      if (!id) throw new Error("usage: verify <runId|latest>");
      const runId = id === "latest" ? (await listBackupRuns(1))[0]?.id : id;
      if (!runId) throw new Error("no runs found");
      const result = await verifyBackup(runId);
      console.log(JSON.stringify(result, null, 2));
      if (result.status !== "verified") process.exitCode = 1;
      break;
    }
    case "drill": {
      const runId = args[0];
      const result = await runRestoreDrill({
        runId,
        actorLabel: "cli/platform-backup",
        keepSchema: flags.has("--keep"),
      });
      console.log(JSON.stringify(result, null, 2));
      if (result.status !== "passed") process.exitCode = 1;
      break;
    }
    case "prune": {
      console.log(JSON.stringify(await pruneBackups(), null, 2));
      break;
    }
    case "freshness": {
      console.log(JSON.stringify(await backupFreshness(), null, 2));
      break;
    }
    default:
      console.log(
        "usage: platform-backup.mts run|list|verify <id>|drill [id]|prune|freshness [--no-remote] [--only=t1,t2] [--keep]",
      );
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
