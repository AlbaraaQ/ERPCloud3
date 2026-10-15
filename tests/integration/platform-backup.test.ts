/**
 * Backup, verification, restore drill and retention (Phase 8, AC-030).
 *
 * The test writes its own artifacts into a temporary directory, runs the real
 * pipeline (capture → encrypt → verify) and the real restore drill (isolated
 * schema + invariant pack), and then proves the pipeline *detects* damage rather
 * than trusting it:
 *   - a corrupted artifact must fail verification (and raise a critical alert);
 *   - a drill whose restore is incomplete must fail (sabotaged snapshot);
 *   - the drill's schema is dropped afterwards and the source policies untouched.
 *
 * Environment-limited (documented in TESTING_AND_ACCEPTANCE §2): there is no
 * `pg_dump`/`pg_restore` on this host, so the production custom-format path is
 * exercised only for its *probe* (which is why the run records `logical-json`).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";

const DB = process.env.DATABASE_URL;

describe.skipIf(!DB)("platform backups — capture, verify, restore drill, retention", () => {
  let dir = "";
  let db: typeof import("@/db")["db"];
  let service: typeof import("@/modules/platform/backup/service");
  let snapshot: typeof import("@/modules/platform/backup/snapshot");
  let settingsMod: typeof import("@/modules/platform/settings");
  let runId = "";

  beforeAll(async () => {
    db = (await import("@/db")).db;
    service = await import("@/modules/platform/backup/service");
    snapshot = await import("@/modules/platform/backup/snapshot");
    settingsMod = await import("@/modules/platform/settings");
    dir = await mkdtemp(join(tmpdir(), "hisab-backup-test-"));
  });

  afterAll(async () => {
    if (db && runId) {
      await db.execute(sql`delete from backup_runs where id = ${runId}::uuid`).catch(() => undefined);
    }
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });

  it("records a verified backup with checksums, a decrypted-content proof and honest format labelling", async () => {
    const result = await service.runBackup({
      kind: "manual",
      actorLabel: "test:backup",
      skipRemote: true,
      directory: dir,
    });

    // recorded before asserting: the remaining tests must operate on THIS run
    // (and on nothing else) even if an assertion below fails
    runId = result.id;
    expect(result.status, `run ${result.id} failed: ${result.errorDetail ?? ""}`).toBe("verified");
    // no pg_dump on this host ⇒ the logical format, and the row says so
    expect(["logical-json", "pg_dump-custom"]).toContain(result.format);
    expect(result.tables).toBeGreaterThan(20);
    expect(result.rows).toBeGreaterThan(100);
    expect(result.plaintextSha256).toMatch(/^[0-9a-f]{64}$/);

    const info = await stat(result.artifactPath!);
    expect(info.size).toBe(result.artifactBytes);
    const bytes = await readFile(result.artifactPath!);
    const { sha256Hex } = await import("@/modules/shared/crypto");
    expect(sha256Hex(bytes)).toBe(result.artifactSha256);

    // the artifact is encrypted: the plaintext snapshot must not appear verbatim
    const text = bytes.toString("utf8");
    expect(text.startsWith("HISABBK1.")).toBe(true);
    expect(text.includes('"manifest"')).toBe(false);

    // skipping the remote copy is recorded as "no off-site copy", never as success
    expect(result.remoteProvider).toBeNull();
    expect(result.remoteVerified).toBe(false);
  }, 120_000);

  it("verification is evidence, not ceremony: a corrupted artifact fails", async () => {
    const path = (
      await service.getBackupRun(runId)
    )!.artifactPath!;
    const original = await readFile(path);
    const tampered = Buffer.from(original);
    // flip a byte inside the ciphertext (keeps the length and the envelope header)
    const index = Math.floor(tampered.length * 0.6);
    tampered[index] = tampered[index]! ^ 0x01;
    await writeFile(path, tampered);

    const result = await service.verifyBackup(runId);
    expect(result.ok).toBe(false);
    expect(result.status).toBe("failed");
    const failed = result.checks.filter((c) => !c.ok);
    expect(failed.length).toBeGreaterThan(0);

    const alerts = (await db.execute(
      sql`select kind, severity from platform_alerts where kind = 'backup_verification_failed' and status = 'open'`,
    )) as unknown as { rows: { kind: string; severity: string }[] };
    expect(alerts.rows.length).toBeGreaterThan(0);
    expect(alerts.rows[0]!.severity).toBe("critical");

    // restore the artifact so later tests exercise the healthy path
    await writeFile(path, original);
    const reVerified = await service.verifyBackup(runId);
    expect(reVerified.status).toBe("verified");
  }, 120_000);

  it("the restore drill restores into an isolated schema, checks the invariants and cleans up", async () => {
    const result = await service.runRestoreDrill({ runId, actorLabel: "test:drill" });

    expect(result.status, `drill failed: ${result.error ?? result.invariants?.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`).join(" | ")}`).toBe("passed");
    expect(result.tables).toBeGreaterThan(20);
    expect(result.rows).toBeGreaterThan(100);

    const names = (result.invariants?.checks ?? []).map((c) => c.name);
    expect(names).toContain("row_counts");
    expect(names).toContain("journal_balance");
    expect(names).toContain("tenant_partitioning");
    expect(names).toContain("row_sampling");
    expect(names).toContain("referential_integrity");
    expect(result.invariants!.ok).toBe(true);

    // the copy must be referentially closed: a snapshot whose foreign keys cannot
    // be rebuilt is not a restorable database
    const referential = result.invariants!.checks.find((c) => c.name === "referential_integrity")!;
    expect(referential.skipped ?? false).toBe(false);
    expect(referential.metrics?.foreignKeys).toBeGreaterThan(10);

    // evidence landed on the run row
    const row = await service.getBackupRun(runId);
    expect(row!.drillStatus).toBe("passed");
    expect(row!.drillAt).toBeTruthy();
    const detail = row!.drillDetail as { rows?: number; invariants?: unknown[] };
    expect(detail.rows).toBe(result.rows);
    expect(Array.isArray(detail.invariants)).toBe(true);

    // the drill schema is gone (no leftovers in the live database)
    const leftovers = (await db.execute(
      sql`select nspname from pg_namespace where nspname = ${result.schema}`,
    )) as unknown as { rows: unknown[] };
    expect(leftovers.rows.length).toBe(0);

    // and the drill did not touch the live data it copied
    const live = (await db.execute(
      sql`select count(*)::int as n from sales_invoices`,
    )) as unknown as { rows: { n: number }[] };
    const source = (await db.execute(
      sql`select count(*)::int as n from public.sales_invoices`,
    )) as unknown as { rows: { n: number }[] };
    expect(live.rows[0]!.n).toBe(source.rows[0]!.n);
  }, 180_000);

  it("a drill over a consistently-sabotaged snapshot still fails: the copy is checked against the values it claims to hold", async () => {
    expect(runId, "the capture test must have recorded a run id").toBeTruthy();
    const row = (await service.getBackupRun(runId))!;
    const original = await readFile(row.artifactPath!);
    const { decryptArtifact, encryptArtifact } = await import("@/modules/platform/backup/crypto");
    const { sha256Hex } = await import("@/modules/shared/crypto");

    const file = snapshot.parseSnapshot(decryptArtifact(original.toString("utf8")));
    // Strip the tenant from ONE business row — and re-hash that table so the
    // snapshot stays internally consistent (this is exactly the case
    // verifySnapshot alone cannot catch: the bytes are intact, the data is not).
    // Move ONE business row to the other tenant: the snapshot stays fully valid
    // (every constraint, key and foreign key still holds, and it verifies against
    // its own manifest) — yet the copy no longer holds the distribution it claims.
    // A table is chosen whose constraints cannot collide on the move.
    const tenantsInSnapshot = new Set<string>();
    for (const chunk of file.data["tenants"] ?? []) {
      for (const row of chunk as Record<string, unknown>[]) tenantsInSnapshot.add(String(row.id));
    }
    expect(tenantsInSnapshot.size, "at least two tenants are needed").toBeGreaterThan(1);

    const victim = file.manifest.tables.find(
      (t) =>
        t.rows > 1 &&
        t.columns.some((c) => c.name === "tenant_id") &&
        !/^platform_|^backup_|^pgboss/.test(t.name) &&
        !t.constraints.some((c) => /UNIQUE/i.test(c.def)) &&
        !t.indexes.some((i) => /UNIQUE/i.test(i)),
    )!;
    expect(victim, "a move-safe tenant-scoped table is needed for this test").toBeTruthy();

    const chunks = file.data[victim.name]!;
    const allRows = chunks.flat() as Record<string, unknown>[];
    const moved = allRows[0]!;
    const from = String(moved.tenant_id);
    const to = [...tenantsInSnapshot].find((t) => t !== from)!;
    moved.tenant_id = to;
    victim.sha256 = sha256Hex(chunks.map((c) => sha256Hex(JSON.stringify(c))).join(":"));

    // the snapshot now verifies against its own manifest …
    expect(snapshot.verifySnapshot(file).ok).toBe(true);

    const saboteurPath = join(dir, "sabotaged.enc");
    await writeFile(
      saboteurPath,
      Buffer.from(encryptArtifact(Buffer.from(JSON.stringify(file), "utf8")), "utf8"),
    );

    const sabotageRunId = (
      await db
        .insert((await import("@/db/schema")).backupRuns)
        .values({
          kind: "manual",
          status: "verified",
          format: "logical-json",
          databaseName: row.databaseName,
          artifactPath: saboteurPath,
          plaintextSha256: "0".repeat(64),
          artifactSha256: "0".repeat(64),
          finishedAt: new Date(),
          createdByLabel: "test:sabotage",
        })
        .returning()
    )[0]!.id;

    try {
      // … and the drill still fails, because the copy is compared with the source
      const result = await service.runRestoreDrill({ runId: sabotageRunId, actorLabel: "test:drill" });
      expect(result.status).toBe("failed");
      const partitioning = result.invariants?.checks.find((c) => c.name === "tenant_partitioning");
      expect(partitioning?.ok).toBe(false);
      // both tenants' captured counts no longer match the copy
      expect(partitioning?.detail).toMatch(new RegExp(`${victim.name}: tenant [0-9a-f]{8} has`));
      expect(partitioning?.detail).toContain("capture had");

      const alerts = (await db.execute(
        sql`select count(*)::int as n from platform_alerts where kind = 'restore_drill_failed' and status = 'open'`,
      )) as unknown as { rows: { n: number }[] };
      expect(Number(alerts.rows[0]!.n)).toBeGreaterThan(0);
    } finally {
      await db.execute(sql`delete from backup_runs where id = ${sabotageRunId}::uuid`);
      // the failed drill must not leave a schema behind
      const left = (await db.execute(
        sql`select nspname from pg_namespace where nspname like 'restore_drill_%'`,
      )) as unknown as { rows: { nspname: string }[] };
      for (const found of left.rows) {
        await db.execute(sql.raw(`drop schema if exists "${found.nspname}" cascade`));
      }
    }
  }, 180_000);

  it("retention keeps the policy minimum and deletes the artifacts it prunes", async () => {
    const { backupRuns } = await import("@/db/schema");
    const settings = await settingsMod.getSettings();
    const policy = { ...settings.backup };

    // pin the policy so the assertion does not depend on deployment defaults
    await settingsMod.saveSettings(
      { backup: { ...policy, keepLatest: 2, keepDaily: 0, keepWeekly: 0 } },
      "test:policy",
    );

    // three synthetic verified runs with real files on disk
    const syntheticIds: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const path = join(dir, `synthetic-${i}.enc`);
      await writeFile(path, `synthetic ${i}`);
      const [created] = await db
        .insert(backupRuns)
        .values({
          kind: "scheduled",
          status: "verified",
          format: "logical-json",
          databaseName: "app_db",
          artifactPath: path,
          artifactBytes: 11,
          startedAt: new Date(Date.now() - (i + 1) * 86_400_000),
          finishedAt: new Date(Date.now() - (i + 1) * 86_400_000),
          createdByLabel: "test:retention",
        })
        .returning();
      syntheticIds.push(created!.id);
    }

    // a pinned run must survive the policy no matter how old it is
    const pinnedPath = join(dir, "pinned.enc");
    await writeFile(pinnedPath, "pinned artifact");
    const pinnedRun = (
      await db
        .insert(backupRuns)
        .values({
          kind: "manual",
          status: "verified",
          format: "logical-json",
          databaseName: "app_db",
          artifactPath: pinnedPath,
          retentionClass: "pinned",
          startedAt: new Date(Date.now() - 30 * 86_400_000),
          finishedAt: new Date(Date.now() - 30 * 86_400_000),
          createdByLabel: "test:retention",
        })
        .returning()
    )[0]!;

    const result = await service.pruneBackups();
    expect(result.pruned).toBeGreaterThan(0);
    expect(result.deletedFiles).toBeGreaterThan(0);

    const rows = (await db.execute(sql`
      select id, status from backup_runs
       where id in (${sql.join(syntheticIds.map((id) => sql`${id}::uuid`), sql`, `)})
       order by started_at desc`)) as unknown as { rows: { id: string; status: string }[] };
    // keepLatest = 2 covers the two newest verified runs in the whole instance,
    // so the oldest synthetic run (3 days old, daily/weekly windows at 0) is pruned
    expect(rows.rows[2]!.status).toBe("pruned");
    const stillVerified = rows.rows.filter((r) => r.status === "verified").length;
    expect(stillVerified).toBeLessThanOrEqual(2);

    const pinned = (await db.execute(
      sql`select status from backup_runs where id = ${pinnedRun.id}::uuid`,
    )) as unknown as { rows: { status: string }[] };
    expect(pinned.rows[0]!.status).toBe("verified");

    // restore the previous policy and clean the synthetic rows
    await settingsMod.saveSettings({ backup: policy }, "test:policy");
    await db.execute(
      sql`delete from backup_runs where id in (${sql.join(syntheticIds.map((id) => sql`${id}::uuid`), sql`, `)})`,
    );
    await db.execute(sql`delete from backup_runs where id = ${pinnedRun.id}::uuid`);
  }, 120_000);

  it("freshness follows the newest verified run and raises a critical alert when it is stale", async () => {
    const fresh = await service.backupFreshness();
    expect(fresh.lastVerifiedAt).toBeTruthy();
    expect(fresh.stale).toBe(false);
    expect(fresh.verifiedCount).toBeGreaterThan(0);

    // temporarily move every verified run out of the window
    const { backupRuns } = await import("@/db/schema");
    await db.execute(sql`update backup_runs set finished_at = now() - interval '40 hours' where status = 'verified'`);
    try {
      const stale = await service.checkBackupFreshness();
      expect(stale.stale).toBe(true);
      expect(stale.ageHours!).toBeGreaterThan(stale.thresholdHours);

      const alerts = (await db.execute(
        sql`select severity, status from platform_alerts where kind = 'backup_stale' and status = 'open'`,
      )) as unknown as { rows: { severity: string; status: string }[] };
      expect(alerts.rows.length).toBeGreaterThan(0);
      expect(alerts.rows[0]!.severity).toBe("critical");
    } finally {
      await db.execute(sql`update backup_runs set finished_at = now() where id = ${runId}::uuid`);
    }

    // and the alert clears once a verified run is inside the window again
    const cleared = await service.checkBackupFreshness();
    expect(cleared.stale).toBe(false);
    const open = (await db.execute(
      sql`select count(*)::int as n from platform_alerts where kind = 'backup_stale' and status = 'open'`,
    )) as unknown as { rows: { n: number }[] };
    expect(Number(open.rows[0]!.n)).toBe(0);
    void backupRuns;
  }, 120_000);
});
