# Operations Runbook — deployment, rollback, incidents, routine jobs

**Audience:** whoever runs the installation (platform ops / DevOps). The user-facing, Arabic
walkthrough of the *product* is `docs/OPERATIONS_GUIDE.md`; this file is the operator's checklist:
what to deploy, in which order, how to roll back, what to watch, and what to do when something
breaks. Policy background: `docs/BACKUP_AND_RECOVERY.md`, `docs/PLATFORM_ADMIN.md`,
`docs/SECURITY_AND_TENANCY.md`.

> **Honesty note.** This project has never been deployed to a real production host: the sandbox it
> was built in has no PostgreSQL server, no `pg_dump`/`psql`, and no outbound access to ZATCA or to
> a model provider. Every command below was executed **against the dev database** (embedded
> PostgreSQL) and the wording reflects that. Where a step needs a real environment (off-site backup
> transport, ZATCA production credentials, a container registry), it is marked
> **[production-only, untested here]**.

---

## 1. What the deployment consists of

| Piece | Artifact | Notes |
|---|---|---|
| Application | Next.js 16 (App Router) — `npm run build` → `.next/` | one process, `npm start` (default port 3000) |
| Database | PostgreSQL 15+ reachable through `DATABASE_URL` | schema applied by `drizzle-kit push` + `src/db/rls.sql` (RLS policies) |
| Job worker | same codebase, `ENABLE_WORKER=true` | pg-boss queues: `heartbeat`, `zatca-submission`, `backup-run`, `backup-verify`, `backup-drill`, `backup-prune`, `platform-maintenance` |
| Secrets | environment only — start from the tracked template `cp .env.example .env`, then fill the empty lines (`.env` itself is gitignored) | `DATABASE_URL`, `HISAB_ENCRYPTION_KEY` (ZATCA private keys and backup artifacts are encrypted with it), provider keys referenced by **name** |
| Backups | `.backups/*.enc` locally + remote transport | remote is `local-contract` in this build — **not** an off-site provider |
| Console | `/platform` inside the same process | separate session namespace (`hisab_platform_session`) |

There are **no migrations**: the schema is pushed with `drizzle-kit push`. For a production
installation, adopt a real migration workflow (or freeze the schema and treat every push as a
reviewed change) — this is a genuine gap, recorded in `docs/PROGRESS.md` residuals.

---

## 2. Deploy (release) — order of operations

```bash
# 0) pre-flight on the release commit
git fetch && git checkout <release-commit>
npm ci
npm run typecheck                      # tsc --noEmit
set -a && . ./.env && set +a && npm test   # full suite (unit + integration)
npm run build                          # production build

# 1) backup FIRST — a deploy must never be the reason a backup is missing
npm run backup:run && npm run backup:verify     # expect: status verified
npm run backup:drill                            # expect: status passed (isolated schema, dropped after)

# 2) environment + schema (only if the release changed src/db/schema.ts)
npm run env:check                               # refuses to continue on a missing/odd key or URL
npm run db:migrate                              # schema push, then the RLS policies (227 of them)
#    `npm run db:seed` is for a NEW deployment only: it resets the demo users' passwords

# 3) application
npm start &                                     # or restart the supervisor/unit
curl -fsS localhost:3000/api/health | head -20  # status ok + backupFreshness not stale

# 4) post-deploy evidence (30 seconds, and it covers every screen)
npm run acceptance:sweep -- --soak=20           # expect: ACCEPTANCE SWEEP PASSED — 39/39
```

**Health gates before declaring the deploy done**

| Gate | Expected | If it fails |
|---|---|---|
| `/api/health` | `status: ok` | see §5 |
| login transport | `npm run login:probe` → `LOGIN PROBE PASSED — 15/15` (tenant form **and** the console's enrollment → TOTP → session path) | the public origin is not allow-listed for Server Actions (`HISAB_ALLOWED_ORIGINS` / `next.config.ts`); every form will 500 in the browser while localhost looks fine |
| screen accessibility | `npm run a11y:audit` → `A11Y AUDIT PASSED — 28 screens, no violations` | a screen lost its direction or language, a control lost its name, or a status is now signalled by colour alone |
| `backupFreshness` | not `stale` (window 4 h by default) | `npm run backup:run` |
| `acceptance:sweep` | 39/39 (routes + namespace isolation + soak) | the failing route names itself in the output |
| `npm test` | 24 test files / 0 failed (authoritative run is on the pre-deploy commit) | do not deploy |

**Deployment window.** Backups and the retention sweep are the only scheduled writers; the
maintenance job runs daily at 01:15. A restore (`platform.backup.restore`) is a maintenance-window
operation, never something to run while users are posting invoices.

---

## 3. Rollback

Rollback is **two decisions**, not one — application and data are separate.

1. **Application only (schema unchanged)** — the normal case:
   ```bash
   git checkout <previous-commit> && npm ci && npm run build && npm start
   ```
   No data action. Verify with `npm run acceptance:sweep -- --soak=0` and `/api/health`.
2. **Application + schema changed** — a code rollback is not enough, because the newer code may have
   written columns the older code cannot read:
   1. Put the system in maintenance (stop the web process; leave the worker or stop it too, your call).
   2. `npm run backup:run && npm run backup:verify` — capture the *current* state first.
   3. Restore into the **same** database only with the two-person rule, typed database-name
      confirmation and the audit trail the console enforces (`/platform/backups`), or restore into a
      scratch database and migrate forward deliberately.
   4. Re-run `npm run backup:drill` against the restored artifact to prove the *artifact you
      restored* holds the invariants (row counts, journal balance, tenant partitioning, FKs).
3. **Never** roll back by deleting rows or by "re-pushing" the schema blindly: `drizzle-kit push`
   can drop what it no longer recognises.

**Restore is the escape hatch, not the rollback strategy.** A release that needs a data restore to
roll back was a release that changed the schema without a compatible migration — record it as a
defect, not as an incident.

---

## 4. Routine operations

| Cadence | Task | Command / screen | Success looks like |
|---|---|---|---|
| continuous | health | `GET /api/health` | `ok`; `backupFreshness` not stale |
| per 4 h (default policy) | backup | `npm run backup:run` (or scheduled) | `status verified`, artifact checksum printed |
| daily 01:15 (worker) | maintenance | `platform-maintenance` queue | log line `aiRetention {swept, conversations, skipped}` then backup-freshness check |
| daily | verify latest | `npm run backup:verify` | 6 checks pass (present, checksum, decrypt, plaintext checksum, content, referential integrity) |
| weekly | restore drill | `npm run backup:drill` | 7 invariants pass; `restore_drill_*` schema dropped |
| weekly | alerts triage | `/platform/alerts` | no `open` critical alerts; ZATCA failures aggregated per tenant |
| monthly | retention pruning | `npm run backup:prune` | only artifacts past policy are removed; `backup:list` shows the survivors |
| monthly | assistant retention | `npm run ai:retention -- --dry-run` then without the flag | dry run reports counts and the cutoff; conversations only are removed |
| on demand | exports | `/platform/exports` | bundle manifest + sha256 + expiring audited link |
| quarterly | access review | `/platform/audit`, support grants | no expired grant left `approved`; no destructive action without two-person evidence |

**Alert semantics that matter during an incident**

- `backup_stale` is a **blocker**: it is surfaced on the console dashboard and by `/api/health`; a
  deployment with stale backups is not release-ready.
- ZATCA failures are aggregated **per tenant, per status** — the console never shows invoice
  content, and no platform screen returns tenant financial amounts.
- The platform audit log is append-only and hash-chained: an "edit" is a new row, and a chain
  verification failure is a security incident, not a data-quality issue.

---

## 5. Incident playbooks

### 5.1 The application is up but the database is unreachable
`/api/health` returns non-200 / `db: error`; every page 500s.
1. Check the database process and `DATABASE_URL` (in the sandbox: the embedded engine process).
2. Restore connectivity **before** restarting the app; a restart loop hides the cause.
3. If the database is lost: restore the last `verified` artifact (§3.2) — never restore an artifact
   whose checksum you have not matched.

### 5.2 Backup freshness has gone stale
1. Run `npm run backup:run` and read the failure: `artifact_present`/`decrypt`/`content` tells you
   whether the problem is disk, key or data.
2. A failed **verify** is worse than a missing backup: it means the artifact on disk cannot be
   trusted. Take a fresh run, then a drill, and treat the lost window as data risk to be disclosed.
3. If `HISAB_ENCRYPTION_KEY` was rotated or lost, old artifacts are unrecoverable — record it and
   restore from the newest artifact encrypted with a key you still hold.

### 5.3 Suspension was the wrong call (tenant locked out read-only)
1. `/platform/tenants/[id]` → set status back to `active`. Suspension is logical and reversible; it
   never deleted anything — that is the acceptance criterion, and it is proven by test
   (`AC-031`-style evidence in `docs/TESTING_AND_ACCEPTANCE.md` §3.3).
2. Confirm from the tenant's own audit view that history is intact.

### 5.4 ZATCA submissions are failing for one tenant
1. `/platform/alerts` → the failure is aggregated per tenant (status + count, no invoice content).
2. In the tenant: `/tax` → check credential status, OTP expiry and the compliance-cycle result.
3. Retry from the submission queue (`zatca-submission`); a clearance/report status is **only** ever
   recorded from ZATCA's own response — the system has no path that synthesizes one.
4. If credentials are the cause, re-run the onboarding cycle **in the right environment**
   (simulation ≠ production templates).

### 5.5 The assistant misbehaves (wrong answer, or a probing user)
1. `/assistant` shows the tools behind each answer; `ai_tool_calls` records denials and escalations,
   `ai_injection_flags` records hostile input (user **or** business data).
2. Kill switch, in order of blast radius: tenant switch (`/assistant/settings`) → platform flag
   `ai_assistant` (`/platform/flags`, immediate effect, audited).
3. A refusal with `escalation_attempt = true` is a signal to review, not an error to silence; the
   platform "AI usage" card counts turns, tokens, refusals and injection attempts — never content.

### 5.6 Suspected data leakage across tenants
1. Freeze writes for the affected tenant (§5.3) — the read-only state is enforced by the database.
2. Pull the evidence: tenant audit log, `platform_audit_log` (chained), tool-call rows, and the
   last verified backup artifact containing the pre-incident state.
3. Check the three isolation layers in order: session tenant binding → explicit `tenant_id`
   predicates in every scoped query → RLS policies (`src/db/rls.sql`).
4. The release gates include a structural test (`tests/unit/ui-guards.test.ts`) that refuses any
   tenant screen importing platform services — use it to confirm the code paths still line up.

---

## 6. What is deliberately *not* in this runbook

- **Deployment automation** (containers, IaC, CI pipeline): not built here.
- **Off-site backup transport**: the build ships the `local-contract` transport, which is honest about
  what it is (a local copy) — pointing it at Google Drive requires provider credentials and is
  **[production-only, untested here]**.
- **Schema migrations**: the project pushes the schema; a versioned migration tool is a release
  blocker for a production go-live and is recorded as such in `docs/RELEASE_READINESS.md`.
- **Horizontal scaling**: the worker is single-process in this build, and the dev engine serializes
  all connections; no scale-out claim is made.

---

## 7. Quick reference

```bash
# setup (new machine, or after a sandbox reboot)
npm run env:setup && npm run env:check && npm run db:migrate && npm run db:seed

# gates
npm run typecheck && set -a && . ./.env && set +a && npm test && npm run build
npm run login:probe && npm run acceptance:sweep -- --soak=20 && npm run a11y:audit

# data safety
npm run backup:run   && npm run backup:verify && npm run backup:drill
npm run backup:list  && npm run backup:status && npm run backup:prune

# maintenance
npm run ai:retention -- --dry-run

# health
curl -fsS localhost:3000/api/health
```
