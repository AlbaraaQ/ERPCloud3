/**
 * `pg_dump --format=custom` path (D-014): the production backup format.
 *
 * The client binaries are **not guaranteed** to exist on the application host
 * (this sandbox has none), so availability is probed once per process instead of
 * being assumed. When the probe fails the caller falls back to the logical
 * snapshot and records `format = logical-json` on the run — a run never claims a
 * pg_dump artifact it did not produce.
 */

import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { stat } from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { logger } from "@/modules/shared/logger";

let probePromise: Promise<PgDumpProbe> | null = null;

export interface PgDumpProbe {
  available: boolean;
  path: string;
  version: string | null;
  reason?: string;
}

function probeOnce(): Promise<PgDumpProbe> {
  return new Promise((resolve) => {
    const candidates = [
      process.env.PG_DUMP_PATH,
      "pg_dump",
      "/usr/bin/pg_dump",
      "/usr/local/bin/pg_dump",
      "/opt/homebrew/bin/pg_dump",
    ].filter((c): c is string => Boolean(c));

    const attempt = (index: number) => {
      if (index >= candidates.length) {
        resolve({ available: false, path: "", version: null, reason: "pg_dump not found on PATH or known locations" });
        return;
      }
      const candidate = candidates[index]!;
      const child = spawn(candidate, ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      child.stdout.on("data", (b: Buffer) => (out += b.toString()));
      child.on("error", () => attempt(index + 1));
      child.on("close", (code) => {
        if (code === 0) {
          resolve({ available: true, path: candidate, version: out.trim() });
        } else {
          attempt(index + 1);
        }
      });
    };
    attempt(0);
  });
}

/** Cached probe (one process = one answer); `resetPgDumpProbe()` for tests. */
export function pgDumpProbe(): Promise<PgDumpProbe> {
  probePromise ??= probeOnce();
  return probePromise;
}

export function resetPgDumpProbe(): void {
  probePromise = null;
}

export interface PgDumpResult {
  path: string;
  bytes: number;
  durationMs: number;
  version: string | null;
}

/**
 * Run `pg_dump --format=custom` into `targetPath`. The connection string is
 * passed through the environment (`PGHOST`/`PGUSER`/…) rather than on the command
 * line so it never lands in the process list. A non-zero exit throws: a failed
 * dump must be recorded as a failure, not uploaded as an artifact.
 */
export async function runPgDump(opts: {
  targetPath: string;
  databaseUrl: string;
  timeoutMs?: number;
}): Promise<PgDumpResult> {
  const probe = await pgDumpProbe();
  if (!probe.available) throw new Error(probe.reason ?? "pg_dump unavailable");

  const url = new URL(opts.databaseUrl);
  const env = {
    ...process.env,
    PGHOST: url.hostname,
    PGPORT: url.port || "5432",
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: url.pathname.replace(/^\//, ""),
  };

  await mkdir(dirname(opts.targetPath), { recursive: true });
  const started = Date.now();

  return new Promise<PgDumpResult>((resolve, reject) => {
    const child = spawn(
      probe.path,
      ["--format=custom", "--no-owner", "--no-privileges", "--file", opts.targetPath],
      { env, stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    child.stderr.on("data", (b: Buffer) => (stderr += b.toString().slice(0, 4000)));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`pg_dump timed out after ${opts.timeoutMs ?? 900_000} ms`));
    }, opts.timeoutMs ?? 900_000);

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", async (code, signal) => {
      clearTimeout(timer);
      if (code !== 0) {
        logger.error({ code, signal, stderr: stderr.slice(0, 500) }, "pg_dump failed");
        reject(new Error(`pg_dump exited with code ${code ?? signal}: ${stderr.slice(0, 300)}`));
        return;
      }
      const info = await stat(opts.targetPath).catch(() => null);
      resolve({
        path: opts.targetPath,
        bytes: info?.size ?? 0,
        durationMs: Date.now() - started,
        version: probe.version,
      });
    });
    // keep the stream referenced so it is not garbage collected mid-run
    void createWriteStream;
  });
}

/**
 * `pg_restore` is required to *replay* a custom-format dump. Its absence is why
 * the drill uses the logical format here; a production restore of a custom dump
 * runs from the runbook on a host that has the binaries.
 */
export async function pgRestoreAvailable(): Promise<boolean> {
  const probe = await pgDumpProbe();
  if (!probe.available) return false;
  return new Promise((resolve) => {
    const child = spawn(probe.path.replace("pg_dump", "pg_restore"), ["--version"], { stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}
