/**
 * `pg_dump` adapter — the production backup path required by D-014.
 *
 * The binaries are probed at runtime and the result is recorded in every run's
 * metadata (`format`), because a host without the PostgreSQL client tools must
 * never be able to silently produce something that looks like a pg_dump
 * artifact. When the probe fails, `runBackup` falls back to the in-app logical
 * snapshot and says so in the row, the console and the docs.
 */

import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { logger } from "@/modules/shared/logger";

export interface PgToolVersion {
  available: boolean;
  path: string | null;
  version: string | null;
}

let cached: PgToolVersion | null = null;

/** Probe `pg_dump` (cached for the process lifetime — the host does not change). */
export async function pgDump(): Promise<PgToolVersion> {
  if (cached) return cached;
  cached = await new Promise<PgToolVersion>((resolve) => {
    const child = spawn("pg_dump", ["--version"], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout?.on("data", (d) => (out += String(d)));
    child.on("error", () => resolve({ available: false, path: null, version: null }));
    child.on("close", (code) =>
      resolve(
        code === 0
          ? { available: true, path: "pg_dump", version: out.trim() || "unknown" }
          : { available: false, path: null, version: null },
      ),
    );
  });
  return cached;
}

/** Test seam: forget the probe (used by tests that simulate a missing binary). */
export function resetPgDumpProbe(): void {
  cached = null;
}

export interface PgDumpResult {
  path: string;
  bytes: number;
  version: string;
}

/**
 * Run `pg_dump --format=custom` into `filePath`. The connection string is passed
 * via `--dbname` (never logged). Throws on a non-zero exit so the caller records
 * a failed run with an error class instead of an unverified artifact.
 */
export async function runPgDump(input: {
  databaseUrl: string;
  filePath: string;
  timeoutMs?: number;
}): Promise<PgDumpResult> {
  const tool = await pgDump();
  if (!tool.available) throw new Error("pg_dump is not available on this host");

  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      "pg_dump",
      ["--format=custom", "--no-owner", "--no-privileges", "--dbname", input.databaseUrl, "--file", input.filePath],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    child.stderr?.on("data", (d) => (stderr += String(d).slice(0, 2000)));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("pg_dump timed out"));
    }, input.timeoutMs ?? 15 * 60 * 1000);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else {
        logger.error({ code, stderr: stderr.slice(0, 500) }, "pg_dump failed");
        reject(new Error(`pg_dump exited with code ${code}`));
      }
    });
  });

  return { path: input.filePath, bytes: statSync(input.filePath).size, version: tool.version ?? "unknown" };
}
