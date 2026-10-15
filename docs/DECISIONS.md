# Decisions, Assumptions, and Open Questions

This file is the canonical record of architectural and business-policy decisions.
Other documents must stay consistent with it. When a decision changes, update the
decision entry (keep history in the `Notes` line), the affected docs, and
`PROGRESS.md`.

**Status legend:** `DECIDED` (binding) · `ASSUMED` (working assumption, low risk) ·
`OPEN` (unresolved — must be answered by the referenced phase) · `FLAGGED` (requires
external/legal confirmation before release).

---

## 1. Architectural decisions (ADR-style)

| ID | Status | Decision | Rationale / alternatives rejected |
|----|--------|----------|-----------------------------------|
| D-001 | DECIDED | **Modular monolith**: single Next.js (App Router) deployable; modules under `src/modules/<name>` with a shared kernel `src/modules/shared`. Microservices deferred. | Team size and domain coupling (invoice↔stock↔accounting) make a transactionally-consistent monolith safer. Services can be extracted later along module boundaries. |
| D-002 | DECIDED | **Multi-tenancy**: one database, shared schema, `tenant_id` on every tenant table. Enforced by (a) tenant-scoped application services, (b) PostgreSQL Row-Level Security on all tenant tables (defense in depth), (c) automated cross-tenant isolation tests. Alternative rejected: schema-per-tenant — operationally heavy, complicates SaaS-wide backup/restore and reporting; no current requirement justifies it. | See SECURITY_AND_TENANCY.md §2. |
| D-003 | DECIDED | **Money math**: `NUMERIC(19,4)` columns; decimal arithmetic only (decimal.js); rounding `HALF_UP` to the tenant currency's minor units (SAR = 2) at the document-line level with totals derived from rounded lines. Quantities `NUMERIC(18,6)`. Binary floats are forbidden anywhere a money/quantity value is computed or compared. | IEEE-754 errors are unacceptable in ledgers. Line-level rounding avoids invoice/tax total drift. |
| D-004 | DECIDED | **IDs**: UUIDv7 primary keys (time-ordered, index-friendly, safe to generate client-side for offline docs). | ULID considered; UUIDv7 native in PG 18 and easy to generate in TS. |
| D-005 | DECIDED | **Document numbering**: per-tenant, per-series counters in a `document_counters` table; the official number is assigned **at posting time only**, under `SELECT … FOR UPDATE`. Drafts carry a temporary local label, never a posted number. Numbers of posted documents are never reused; uniqueness enforced by DB constraint. ZATCA ICV is a separate per-EGS monotonically increasing counter used for hash chaining. | Prevents duplicates/gaps on retry; posting-time assignment keeps posted sequences gapless even if drafts are discarded. |
| D-006 | DECIDED | **Single posting engine**: one `PostingService` (accounting) and one `StockLedgerService` build and write all journal entries / stock movements inside one DB transaction with their source document. Idempotency key: unique `(source_type, source_id, effect_kind, tenant_id)` on `journal_entries` and `stock_ledger`. No module writes its own postings. | One authoritative implementation of accounting/stock rules (brief §3). Unique source constraint makes retries impossible to double-post. |
| D-007 | DECIDED | **Immutability of posted documents**: posted financial documents cannot be edited/deleted (status-machine guard + DB rule). Corrections = reversal document referencing the original, then optionally a new corrected document. Reversals are unique per original (`UNIQUE(original_id)` per effect). | Auditability; invariant INV-03/04. |
| D-008 | DECIDED | **Inventory ledger**: append-only `stock_ledger`; `stock_balances` is a materialization updated in the same transaction (balance row locked `FOR UPDATE`) and reconciled against the ledger by a scheduled job. Negative stock blocked by default (CHECK + locked balance update); per-warehouse exception requires explicit config + permission and is audited. | INV-05/06/15. |
| D-009 | DECIDED | **Costing**: default **weighted moving average** per (warehouse, product); expiry-tracked products additionally use **FEFO batch selection** at issue time. Production output cost = Σ consumed lots (actual lot cost) + allocated labor/overhead − by-products; posting with zero/missing cost inputs is **blocked** with a configuration error. | Predictable, standard for food/FMCG SMEs. Batch-level FIFO selectable per product later without schema change (lots already carry unit cost). |
| D-010 | DECIDED | **AuthN/Z**: server sessions (httpOnly, Secure, SameSite=Lax signed cookie), Argon2id password hashing, RBAC (`roles`, `permissions`, `role_permissions`, `user_roles`) + per-role approval limits; every protected operation checked **server-side** in the application service. UI hiding is never a control. | Brief §3/§12. |
| D-011 | DECIDED | **Rep app = PWA**: installable; app-shell cached by a service worker; durable outbox in IndexedDB (Dexie); idempotency-deduplicated push + high-watermark pull protocol; exponential backoff with jitter; conflict states surfaced in a sync dashboard. iOS background-sync/notification limits are documented, not worked around. | Offline-first field use (brief §5). Native wrapper deferred. |
| D-012 | DECIDED | **ZATCA integration boundary**: dedicated `tax` module with an adapter to the official FATOORA APIs; **simplified (B2C) = reporting**; **standard (B2B) = clearance before sharing with buyer**; submissions tracked per invoice with full status history; never fabricate QR/stamps/clearance results; certificates stored outside source control; sandbox first. Exact endpoints/payloads/cryptography **must be implemented from current official ZATCA developer documentation** — this repo must not invent them. Legal limits of offline issuance are FLAGGED (OQ-2, OQ-3). | Brief §7 + INVOICING_AND_ZATCA.md. |
| D-013 | DECIDED | **Background jobs**: `pg-boss` (PostgreSQL-backed queue) run in-process with the app; retries with backoff + dead-letter; `/api/health` reports queue & backup freshness. Backup schedule: every 4 h by default. | No extra infra required in sandbox or early production; durable, transactional enqueue. |
| D-014 | DECIDED | **Backups**: `pg_dump` custom format → AES-256 encryption → SHA-256 checksum → local artifact + optional Google Drive upload (OAuth refresh token held in encrypted secrets store, never in repo). A backup counts as successful only after artifact existence + checksum + (for Drive) remote metadata verification. Restore is platform-only, audited, with documented drill. Retention: ≥18 latest successful ≈ 3 days at 4 h; optional daily/weekly GFS. | Brief §10 + BACKUP_AND_RECOVERY.md. |
| D-015 | DECIDED | **i18n/RTL**: Arabic (`ar-SA`) is the default UI language and document direction (`dir="rtl"`); English secondary via typed dictionary module (no mixed-language strings). Western digits by default; Arabic-Indic digits configurable (A-3). Hijri display optional; storage always Gregorian/UTC. | Brief §14. |
| D-016 | DECIDED | **Dates/time**: store `timestamptz` (UTC) for instants; every business document also carries `business_date` (tenant-local date, tenant time zone, default `Asia/Riyadh`) captured at creation. Reports group by `business_date` unless a filter says otherwise. | INV-14; determines period & aging boundaries. |
| D-017 | DECIDED | **Testing**: Vitest (unit/service/integration against an ephemeral Postgres schema) + Playwright (E2E incl. offline/restart flows) + DB-constraint/concurrency test suites. Gates: typecheck, lint, unit, integration on every change; E2E pre-release. | TESTING_AND_ACCEPTANCE.md. |
| D-018 | DECIDED | **Audit**: append-only `audit_log` (`tenant_id, actor, action, entity, entity_id, before, after, ip, ua, at`) written in the **same DB transaction** as the change. Tax config, permission grants, price overrides, stock adjustments, settlement approvals, journal reversals, exports are always audited. | Brief §12/§15. |
| D-019 | DECIDED | **AI assistant**: provider-agnostic adapter (OpenAI-compatible + Anthropic-compatible base URLs/keys from env). Permission-aware, server-side tool registry (zod-validated); v1 tools are read-only analytics; any mutating action requires a human approval ticket executed through normal services — the model can never post, delete, reverse, change tax config, payroll, or settlement. Disabled per-tenant by default. | AI_ASSISTANT.md. |
| D-020 | DECIDED | **Platform console**: separate `/platform` route group with its own `platform_users` table and roles (Owner, Ops). No implicit access to tenant financial data; support access is time-boxed, scope-limited, audited break-glass. | PLATFORM_ADMIN.md. |
| D-021 | DECIDED+FLAGGED | **Free goods**: explicit invoice line kind `free`; revenue 0, stock issued and costed normally at issue; inventory cost posted to a configured "free goods / samples" expense account (never COGS by default, policy-configurable). VAT treatment is a **configurable policy flag** per tenant, default = "out of scope pending advisor ruling" — FLAGGED OQ-4. A zero-priced line is never auto-treated as exempt. | Brief §4.7. |
| D-022 | DECIDED | **Settlement**: state machine `requested → under_review → (exceptions loop) → approved → posted → closed`; `SELECT … FOR UPDATE` on the settlement row for the full review/finalize flow. Shortages/surpluses always become **exception records first**; employee receivables only after documented investigation + authorized approval, posted via configured mapping; never an automatic payroll deduction. | Brief §8; VAN_SALES_WORKFLOW.md §6. |
| D-023 | DECIDED | **Deployment & rollback**: single production build; migrations via drizzle-kit (`push` in sandbox, versioned `migrate` files for real environments) applied at deploy; rule: migrations must be backward-compatible with the previous app version (expand-then-contract) so rollback = redeploy previous build. Destructive changes ship as two-phase migrations. | Brief §17/§18. |
| D-024 | DECIDED | **Secrets**: environment variables only; Google Drive tokens and ZATCA private keys/certificates stored encrypted in DB (app key from env) or mounted files with 0600 perms; never in source control; never logged. Rotation procedure documented in SECURITY_AND_TENANCY.md. | Brief §3/§10. |
| D-025 | DECIDED | **Session continuity**: `docs/PROGRESS.md` updated at end of every session; docs updated whenever a decision, contract, or workflow changes. | Brief §2. |
| D-026 | ASSUMED | **Single base currency per tenant in v1** (configurable currency/number/date formats per tenant); multi-currency transactions deferred to a later phase. Recorded as OQ-10 until confirmed. | Reduces FX revaluation complexity in v1. |

## 2. Working assumptions (low-risk, reversible)

| ID | Assumption | Impact if wrong |
|----|------------|-----------------|
| A-1 | Tenants are primarily Saudi-based SMEs (VAT 15% standard rate default category seeded but always configurable per product/transaction). | Tax config UI already supports multiple jurisdictions; adjust seed data. |
| A-2 | Rep devices are Android (best PWA support); iOS works with documented background-sync limits. | More conservative sync UX on iOS. |
| A-3 | Western (0-9) numerals in UI by default; Arabic-Indic optional per tenant. | Purely display-layer switch. |
| A-4 | Deposits/e-payments settle through provider webhooks or manual reconciliation by accountant. | More manual reconciliation workload. |
| A-5 | v1 supports one active POS session per cashier device. | Session table needs constraint change later. |

## 3. Open questions (MUST NOT be silently answered in code)

| ID | Question | Needed by | Owner / input required |
|----|----------|-----------|------------------------|
| OQ-1 | Jurisdictions beyond Saudi Arabia in scope for v1 (UAE VAT, other)? | Phase 6 | Product owner. Affects tax config & reporting breadth. |
| OQ-2 | **Legal sign-off**: offline issuance of *simplified* e-invoices with reporting ≤ 24 h after reconnect — confirm the exact current ZATCA allowance, conditions, and any time window for the tenant's integration wave. | Phase 6 (release blocker) | External tax/legal advisor + official ZATCA docs. |
| OQ-3 | **Legal sign-off**: standard (B2B) invoices require pre-issuance clearance, so offline issuance appears non-compliant. Confirm business accepts hard-blocking offline standard invoices (they stay local drafts, not evidence of supply). | Phase 6 (release blocker) | Advisor + business owner. |
| OQ-4 | VAT treatment of free goods/samples (out-of-scope vs deemed supply at fair value) and of representative free-goods promotions. | Phase 6 | Tax advisor ruling per tenant. Controls D-021 policy flag default. |
| OQ-5 | Payroll deduction legal basis & caps (KSA Labor Law) for shortage-related employee receivables; HR policy text. | Phase 3/4 (HR) | Tenant HR/legal. System must not infer permission from a manager approval alone. |
| OQ-6 | Hijri date display requirement on printed invoices/reports? | Phase 1 (UX foundation) | Product owner. |
| OQ-7 | Data-residency / hosting-region constraint for production? | Phase 8 | Product owner. |
| OQ-8 | Which ZATCA integration wave applies to each tenant (revenue-based deadlines) and their FATOORA onboarding owner? | Phase 6 | Tenant onboarding process. |
| OQ-9 | Default offline transaction limits per rep (max open offline invoices, max value, max offline credit) and oversale conflict policy. | Phase 4 | Business owner; conservative defaults exist (OFFLINE_SYNC.md §6) but are provisional. |
| OQ-10 | Confirm single-currency v1 (D-026). | Phase 2 | Product owner. |
| OQ-11 | E-payment provider(s) for field collections (mada/STC Pay/bank transfer only at first?) | Phase 4 | Product owner; affects settlement & reconciliation screens. |

**Rule (from the brief): missing answers produce explicit configuration errors or blocked
workflows in the product — never guessed defaults.** This applies especially to OQ-2/3/4.
