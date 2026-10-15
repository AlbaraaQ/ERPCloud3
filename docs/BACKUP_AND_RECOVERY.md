# Backup & Recovery (Platform-Owned)

Backups are a **platform-owner** capability; ordinary tenant admins can request exports
but never restore the platform database (D-014, FR-090).

## 1. What gets backed up (scope clarity)

| Scope | Content | Who |
|-------|---------|-----|
| **Platform database backup** (this document) | entire PostgreSQL database: all tenants + platform tables | platform jobs/console |
| Tenant export (§8) | one tenant's data as a portable bundle (JSON/CSV + attachments refs) | tenant request, platform-verified, tenant-scoped only |

A tenant must never receive another tenant's data — exports are generated with the
tenant's RLS context and verified by row-count checks + random row sampling.

## 2. Schedule & retention

- **Every 4 hours** by default (pg-boss `backup` queue), staggered to off-peak minutes.
- Retention: keep **≥ 18 latest successful** backups (≈ 3 days at 4 h) as minimum;
  optional GFS: last 14 daily + last 8 weekly (config per platform policy). Deletion of
  expired artifacts is itself audited.
- RPO = 4 h (backup cadence). RTO target: 2 h for a single-node restore of reference
  size (validate during Phase 8 drill; record actuals in PROGRESS.md).

## 3. Procedure (every run)

1. `pg_dump --format=custom` (all schemas) from a read-only snapshot where available.
2. Compute SHA-256 of the dump; encrypt (AES-256; key from env/secret store, never in repo).
3. Write artifact locally (`<ts>-<db>.dump.enc`) + metadata row: started/finished, size, sha256 (of plaintext and artifact), destination(s), status machine `running → local_ok → uploaded → verified` (failure states with error class).
4. Optional Drive upload (§4), then **verify**: local file exists + checksums match; for Drive, re-read remote file metadata (size/md5) and compare. Only `verified` counts as success (never "job ran" = success).
5. On failure: retry with backoff (×3), then alert (notification center + platform dashboard + optional email) with error detail minus secrets.

## 4. Google Drive integration

- OAuth2 with **offline** scope; refresh token stored encrypted (D-024); bound to a dedicated "ERP Backups" folder (id stored in platform settings).
- Resumable upload for large artifacts; verification by remote metadata; Drive API errors classified (quota/auth/network) with retry policy; token expiry → alert.
- Folder hygiene: retention pruner deletes expired remote artifacts (matched by metadata, never by name pattern alone).

## 5. Integrity beyond checksums

- Nightly light check: newest artifact decryptable + `pg_restore --list` parses.
- **Restore drill (mandatory before release, then quarterly)**: restore latest backup into an **isolated** database → run invariant checks (TB balances, invoice counts vs metadata, RLS smoke) → record evidence (timestamps, row counts, checksums) in `PROGRESS.md`/ops log. A backup that has never been restored is a hypothesis, not a capability.

## 6. Restore (platform-only)

1. Prerequisites: Platform Owner + second-approver (two-person rule), written incident ref, target environment confirmed (**production restore needs explicit typed confirmation of the DB name**).
2. Steps: snapshot current state (safety backup) → provision clean DB → decrypt + restore → point-in-time note if PITR available → apply any migrations delta → run invariant checks → switch over / inform tenants. Every step audit-logged.
3. Tenant-level selective restore: v1 = full-restore-to-staging + assisted export of the tenant's data (documented; self-serve row-level restore is post-v1).
4. Never expose restore actions to tenant roles; the console hides restore without the `platform.backup.restore` permission and requires typed confirmation + audit.

## 7. Monitoring

- Dashboard: last 30 runs (status, size, duration, destination), age of last **verified** backup (alert if > 8 h — "stale backup monitor"), storage usage, Drive status.
- Health endpoint includes backup freshness; missed schedule = incident-level alert.

## 8. Tenant export (contract)

Contents: company config, COA, parties, catalog, documents (invoices/receipts/etc.), journals, stock ledger, settlements, submissions metadata, audit excerpts; format: versioned JSON + CSV pack + manifest with row counts + sha256 per file. Generation via job; download link expiring, single-tenant, access audited (D-018). Legal retention (OQ-8) honored before any deletion workflow.

## 9. Security

Artifacts encrypted at rest (local + Drive), keys in env/secret store; transfer over TLS; no credentials in logs or metadata rows; console actions permission-gated + audited; download URLs signed & expiring.

## 10. Implementation notes — rules that each cost a defect

- **The capture cursor must be a real tid.** `max(ctid::text)` orders lexicographically, so
  `(9,99)` sorts above `(10,1)`: the chunked capture then re-reads a range on every chunk and
  silently duplicates rows. The artifact stays internally consistent (its per-chunk hashes
  cover the duplicates), so only replaying it into a schema with primary keys catches it —
  use `max(tid)`, never the text form. Verified: 0 duplicates over a 75-table / 8.6k-row
  capture.
- **A restore must never reference the live schema.** `pg_get_constraintdef` omits the schema
  for tables on the capture session's search path, so a captured FK reads
  `REFERENCES tenants(id)`. Replaying it verbatim binds the drill to the *live* tables: it
  "passes" while the database matches the snapshot and fails as soon as the database
  legitimately moves on — i.e. it never tested the copy. Every reference is rewritten to the
  target schema before replay.
- **Keys before foreign keys.** The manifest is ordered by table name, so `accounts` (FK →
  `tenants`) is replayed before `tenants` has its primary key (`42830`). Keys/unique/checks
  first, then FKs, retried until no further progress.
- **A skipped index is a finding, not a log line.** Index replay failures are returned as
  `skippedIndexes`, surfaced as the `indexes` check on the drill, and fail the drill.
- **Tenant-less rows are only legitimate where the schema says so** — a global feature flag
  (`scope = 'global'`) or a deletion-register row whose tenant has been purged
  (`status in ('purged','cancelled')`). Everywhere else a NULL `tenant_id` is a row that lost
  its tenant, and `tenant_partitioning` reports it.
- **`session_replication_role = replica` disables RI triggers**, so a purge cannot rely on
  `on delete set null`; references from surviving rows must be released explicitly. (It also
  cannot rely on *any* FK action — which is why the purge is catalog-driven rather than
  hand-written.)
- **Drills are evidence, not ceremony.** The drill writes its checks, row counts, RTO and
  schema name onto the run row. Here the copy is an isolated `restore_drill_*` schema inside
  the same database (the dev engine cannot host a second one); the same code restores into a
  separate database when one is available.
