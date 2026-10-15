# Security & Tenancy

## 1. Threat model (summary)

Cross-tenant data leakage · rep device theft/loss · dishonest-insider edits of posted
financials · sync replay/tampering · privilege escalation via client-side checks ·
secret/certificate exposure · support-access abuse · prompt injection via AI tools.

## 2. Tenant isolation — three layers (D-002)

1. **Application**: every tenant-scoped query goes through services that inject the
   session's `tenant_id`; raw cross-context queries are banned (lint rule + review).
2. **Database (defense in depth)**: Row-Level Security enabled + forced on every tenant
   table; policy `tenant_id = current_setting('app.tenant_id')::uuid`; the app sets
   `app.tenant_id` per transaction. Platform DB role has `NOBYPASSRLS` on tenant tables;
   only the platform-owner maintenance role bypasses for platform operations.
3. **Tests**: automated isolation suite — cross-tenant reads/writes attempted and must
   fail (INV-16), run in the Phase 1+ gate forever.

Tenant IDs from the client are never trusted: the session binding wins; a mismatch is a
security event (audit + alert).

## 3. Authentication

- Passwords: Argon2id (memory-hard params documented in code; rehash-on-login when params change); minimum 10 chars + blocklist; optional 2FA (TOTP) per tenant policy — required for platform console.
- Sessions: server-side session records + httpOnly, Secure, SameSite=Lax signed cookies; idle timeout (tenant-configurable, default 12 h ERP / 24 h rep w/ device binding); absolute max 30 days; mandatory rotation on privilege change.
- Rep devices: registered `devices` record (name, platform, fingerprint, bound user); per-device credentials (short-lived tokens + rotating refresh); registration audited; revocation kills push/pull immediately and signals the app to wipe local data (best-effort, documented).

## 4. Authorization (RBAC + limits, D-010)

- Tables: `roles` (seed + tenant-custom), `permissions` (catalog: `module.action.scope`, e.g. `sales.post.own`, `inventory.adjust.any`, `settlement.finalize.any`), `role_permissions`, `user_roles`, optional per-user overrides (audited), `approval_limits` (amount ceilings per role/action).
- Initial roles: Platform Owner · Platform Ops · Tenant Owner · Accountant/System Manager · Sales Manager · Warehouse Manager · Production Manager · Cashier · Field Sales Rep · Auditor(read-only).
- **Server-side enforcement in services** (`requirePermission(ctx, "sales.invoice.post", scope)`); route/UI gating is convenience only. Scope narrowing for reps: assigned customers/branches/products + own custody warehouse only.
- Separation of duties seeds: who creates ≠ who approves for journals, stock adjustments, settlements, price overrides, employee receivables.

## 5. Data protection

- In transit: TLS everywhere (deployment requirement).
- At rest: provider/volume encryption for DB; **field-level AES-256-GCM** (app-managed key from env) for: Google refresh tokens, ZATCA private keys/certificates, AI provider keys, session secrets at rest. Backups encrypted (D-014).
- Secrets: env vars only; never in repo; never in logs (pino redact list); rotation procedure: dual-key window then revoke (documented in ops runbook).
- PII minimization on rep devices: only assigned customers (name/phone/area/balance state needed), permitted products, own history; encrypted-at-rest browser storage is best-effort (WebCrypto-wrapped key + device lock guidance — platform limit disclosed in OFFLINE_SYNC §8).

## 6. Sync & API hardening

- Push ops: authenticate device → validate signature of op envelope (op_id, device_id, tenant binding, payload hash) → idempotency table → **payload-hash mismatch for an accepted op_id = tamper → reject + security audit event** → apply in tx with full server-side validation (prices, totals, taxes recomputed; permissions re-checked server-side).
- Rate limits: per-IP login throttling + per-device sync caps + expensive-report throttles; 429 with backoff hints; abuse patterns flagged to platform console.
- Webhooks: provider signature verification; replay protection via event-id dedupe.

## 7. Audit (D-018)

Append-only `audit_log` (and `platform_audit_log` for console) written in the same tx as
the change: actor, action, entity/id, before/after JSON, ip, user-agent, at. **Always
audited**: auth events, permission changes, period close/reopen, posting mappings, tax
config, price overrides, stock adjustments, settlement steps/approvals, reversals,
exports, backup/restore ops, device registration/revocation, break-glass grants, AI tool
calls. Tamper-evidence: hash-chained audit rows (each row references previous row hash
per tenant) — verification job reports breaks.

AI assistant specifics (implemented, AI_ASSISTANT §8): tool calls are recorded with their
arguments, outcome, row count, denial reason and an escalation flag; refusals and injection
attempts are audited rather than dropped; the model is given no write tool at all (mutations
are approval tickets executed by a human with the intent's permission); **no tool accepts a
tenant identifier**, so nothing the model produces can point at another tenant; free-text
business memos are withheld under `metrics_only` (prose cannot be masked the way a name can).

## 8. Platform support access (break-glass)

No default access to tenant financial data (D-020). Exceptional support access requires
`support_grants` (platform approver + tenant approver, scope-limited tables/screens,
time-boxed ≤ 24 h default, full audit of every view/action, tenant notified). All access
through a dedicated read-mostly support view; exports prohibited under support grants.

## 9. Privacy & retention

- Tenant data export: complete machine-readable bundle (per BACKUP_AND_RECOVERY §8) on request; deletion workflow: export offer → written confirmation → scheduled purge per retention/legal holds (audit of every step; ZATCA-mandated retention periods honored — FLAGGED to confirm exact years with advisor, OQ-8).
- Minimal data to AI providers (AI_ASSISTANT §5). Arabic-first UI with exact status vocabulary reduces "shadow" data handling.

## 10. Security testing (mandatory, TESTING_AND_ACCEPTANCE §4)

AuthZ matrix tests (every role×sensitive action), isolation tests, sync tamper tests
(payload hash, replay), session-expiry/revocation tests, rate-limit smoke, audit-hash
verification; dependency audit in CI.

## 11. Non-goals v1

SSO/SAML (later), hardware tokens, DLP tooling, WAF-as-code (deployment concern, noted in
runbook). These are documented gaps, not silent omissions.
