# Platform Owner Administration Console

Separate interface at `/platform` with its own user store (`platform_users`), roles
(Platform Owner, Platform Ops), mandatory 2FA for Owner, and full platform audit
(D-020). It operates the SaaS — it is **not** a backdoor into tenant books (§6).

## 1. Capabilities

### 1.1 Tenant lifecycle
`create → trial → active ⇄ suspended → deactivated`; deactivation is logical (data
retained per retention/legal rules). Suspension preserves **all** history; expired
subscriptions enter configurable **read-only + export** mode never destructive purge
without the deletion workflow (§5).

- Create: owner user, company profile, plan, trial dates, seeded COA template + defaults.
- Suspend/reactivate: reason + audit; suspended tenants: login blocked except owner
  read-only banner; background sync returns 403 with reason; backups continue.
- Quotas & entitlement enforcement: users, branches, warehouses, invoices/month, storage;
  exceeded → warnings then hard blocks at POST boundaries per plan policy.

### 1.2 Plans & subscriptions
Catalog of plans (entitlements JSONB: features, quotas, price), subscription records
(status, renewal date, invoice of subscription — the platform's own billing, separate
from tenant accounting), renewal reminders, proration notes manual-v1.

### 1.3 Feature flags
Global + per-tenant flags (e.g., `manufacturing`, `ai_assistant`, `drive_backup`,
`beta_*`). Flag changes audited; cached per request only — immediate effect.

### 1.4 Monitoring & operations
- Dashboards: tenants count by status, new trials, MRR (declared), usage samples
  (`usage_metrics`: storage, doc counts, active reps, sync ops/day).
- Health: per-service status, pg-boss queue depth & dead letters, oldest unprocessed job,
  backup freshness (BLOCKER widget), sync error rates, ZATCA integration failures by
  tenant (aggregated status only — no invoice content).
- Alerts inbox: stale backups, job failures, invariant drift, quota breaches, security
  events (tamper rejections, isolation alarms); acknowledge/assign workflow.

### 1.5 Backup & recovery operations
Per BACKUP_AND_RECOVERY.md: run-now, history, verify, Drive status, retention config,
restore initiation (two-person rule + typed confirmation + full audit).

## 2. Support tools (break-glass, D-020)

- No standing access to tenant financial data. Support session requires
  `support_grants` record: tenant approver + platform approver, scope (screens/tables),
  expiry ≤ 24 h, then a read-mostly support mask (amounts visible, documents openable
  per grant scope; exports blocked). Every screen view under a grant writes a
  `platform_audit_log` row; the tenant sees the session in its own audit view.
- Impersonation is forbidden; support views are side-by-side with the grant banner.

## 3. Platform audit log

Append-only, hash-chained like tenant audit: every console action (tenant create/suspend,
plan change, flag change, backup op, grant create, export, restore step). Review screen
with filters; export restricted to Platform Owner.

## 4. Abuse controls

Global and per-tenant rate limits; login throttling; device-registration caps;
sync-ops quotas; anomalous pattern flags (sync storms, brute-force, mass exports) →
alert + optional auto-throttle; incident runbook link.

## 5. Data lifecycle workflows

- Export: tenant-requested complete bundle (BACKUP_AND_RECOVERY §8), job-generated,
  expiring link, audited.
- Deletion: request → export offer → written confirmation → cooling-off (config, default
  14 days) → purge job honoring legal retention holds (ZATCA-related years, OQ-8) →
  certificate/anonymization of residual references → audit record of every step.
  Deletion never breaks other tenants; platform aggregates use pre-computed metrics only.

## 6. Hard boundaries (tests must prove)

1. Platform roles cannot query tenant ledger/stock/invoice tables without a valid grant row (RLS + service checks).
2. Tenant users cannot reach `/platform` (separate session namespace).
3. Suspension/deactivation never deletes rows.
4. All console mutations appear in platform audit log.
5. Console is not reachable using tenant-scoped sessions and vice versa.

## 7. UX

Arabic-first like the ERP (same design system), dark/light, keyboard-friendly tables,
status vocabulary shared with tenant apps (labels, not color-only), dense operational
layouts with progressive disclosure; destructive actions = typed confirmations.

## 8. Implementation notes

- **Viewing and changing are different rights.** Every screen has a `.view` code as well as
  its mutation code; `ops` holds every `.view` plus operations, `owner` holds everything.
  A screen that requires a code the catalog does not define is indistinguishable from a
  denial — and denies the owner too. A regression test asserts that every code the console
  requests exists, that `ops` can open every screen it is shown, and that no page imports a
  value from a `"use client"` module (a function crossing that boundary compiles and 500s).
- **Scope tenant reads explicitly.** The application connects as a privileged role in this
  deployment (the database owner bypasses RLS), so a bare `count(*)` inside a tenant
  transaction reports the whole database. Row-level security is defence in depth, not the
  only guard: every platform query carries `where tenant_id = …`.
- **A purge takes the export bundles with it.** A bundle is a complete copy of the tenant's
  data; deleting the rows while leaving the files would make "deleted" a claim the disk
  contradicts. The purge removes the tenant's artifacts (recorded paths, plus a sweep of the
  export directory by tenant prefix as a backstop) and records the count on the certificate.
- **The deletion register outlives the tenant.** `deletion_requests` keeps the certificate and
  the audit trail, so its `tenant_id` is nullable (`on delete set null`) and the purge must
  release its references by hand (`session_replication_role = replica` disables the FK action
  that would otherwise do it). A second purge of the same request is refused.
- **The audit chain is never tenant data.** `platform_audit_log` is excluded from tenant
  purges and from tenant-partitioning comparisons; the append-only trigger refuses
  `UPDATE`/`DELETE` (`23001`). A re-baseline, if it ever becomes necessary, is itself recorded
  as an audit event — never done quietly.
- **A stale session is not a dead end.** A revoked, expired or disabled-account cookie
  redirects to `/platform/login?expired=1`; enrolment without a pending token returns to
  sign-in. `"use server"` modules may only export async functions — shared constants live in
  `session.ts`.
