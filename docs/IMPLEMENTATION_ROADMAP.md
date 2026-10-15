# Implementation Roadmap

Dependency-ordered delivery plan. **Rule:** do not start a phase whose dependencies are
not verified working and tested. Every phase ends with: tests executed, docs updated,
`docs/PROGRESS.md` appended, and the full validation gate
(`next typegen` → `tsc --noEmit` → `next build` → platform `build_and_start`) passing.

**Current pointer:** Phases 0–7 ✅ complete (AC-025 environment-limited) · **Phase 8 implemented** — `/platform` console (tenants, plans/entitlements, flags, quotas, alerts, audit, exports), verified backups + restore drills, support grants, deletion workflow; residuals listed in `PROGRESS.md` Session 10 → **Phase 9 (AI assistant) next**.

---

## Phase 0 — Repository assessment & documentation ✅

- Inspect repo; inventory reusable assets; classify DB posture (empty/disposable sandbox).
- Create and cross-review the full `docs/` package (19 files).
- Record decisions (D-###), assumptions (A-#), open questions (OQ-#) in `DECISIONS.md`.
- Evidence: baseline `typegen`/`tsc`/`build` captured in `PROGRESS.md`.

**Exit:** this file + all linked docs exist and agree with each other. ✅

## Phase 1 — Technical foundation ✅ (completed 2026-10-15; evidence in PROGRESS.md session 2)

**Depends on:** Phase 0.

1. App structure `src/modules/*` + shared kernel (Result/error types, money, dates, audit helpers, id-generator).
2. Database foundation migration: `tenants`, `platform_users`, `companies`, `branches`, `users`, `roles`, `permissions`, `user_roles`, `audit_log`, base RLS policies, `document_counters`, `notifications`.
3. Session auth (Argon2id, httpOnly cookie) + login/logout + tenant selection; seed bootstrap (platform owner, demo tenant owner).
4. RBAC guard helpers enforcing server-side checks in services; middleware-level route protection.
5. Design-system foundation: RTL layout shell (`lang="ar" dir="rtl"`), Arabic font (IBM Plex Sans Arabic), light/dark theme tokens, locale dictionary module, role-aware navigation shell, health endpoint extension.
6. pg-boss job runner bootstrap + structured logging (pino) + request-id propagation.
7. CI-equivalent local gate (typecheck/lint/unit) + Vitest configured; first auth/tenancy isolation tests.

**Exit:** login works end-to-end; tenant isolation proven by tests; audit log records auth events; Arabic RTL shell renders in both themes; gate passes.

## Phase 2 — Accounting & inventory foundations ✅ (completed 2026-10-15; evidence + residuals in PROGRESS.md session 3)

**Depends on:** Phase 1.

1. COA + account groups + tenant default COA template (per ACCOUNTING_POLICY.md §3); posting-mapping configuration screen with **missing-mapping blocking errors**.
2. Fiscal years/periods; open/close/reopen with auth + audit; no-posting-to-closed-period guard.
3. `journal_entries/lines` + PostingService (balanced-check, idempotent per source) + general journal UI w/ approval flow; reversals.
4. Products, categories, brands, UoM + conversions, price lists, barcodes, tax categories.
5. Warehouses (incl. quarantine & virtual in-transit), `stock_ledger` + `stock_balances` + StockLedgerService (locks, negative-stock rule), opening stock, stock receipts/issues/adjustments, transfers state machine.
6. Costing engine (WAC + FEFO batch selection), lot/expiry capture, ledger↔balance reconciliation job + invariant tests.

**Exit:** balanced-journal invariant proven (DB constraint + tests); stock cannot go negative under concurrency (test); ledger = balances (reconciliation test); posting into closed period rejected (test).

## Phase 3 — Customers, suppliers, sales, purchasing, cash & banks ✅ (completed 2026-10-15; evidence + residuals in PROGRESS.md session 4)

**Depends on:** Phase 2.

1. Customers/suppliers (credit limits, holds, terms), statements, aging, allocation engine (receipts/payments/advances), returns + credit/debit notes.
2. ERP POS (fast, keyboard-first) + invoice document model with 4 status dimensions; **Save dialog with Action A (Save & Post) / Action B (draft)** per INVOICING_AND_ZATCA.md §5; customer pricing, price-boundary enforcement, discounts w/ approval, free-goods lines, partial/multiple payments.
3. Purchase orders → goods receipts → supplier invoices; purchase returns; landed costs; price/qty variance posting.
4. Cashboxes/bank accounts, transfers, receipts/payments, e-payment records with settlement state, expenses + categories + attachments + approval limits, bank reconciliation.
5. Employees + HR basics (records, salary structures, advances); commission rules (calculation only — payroll run in Phase 4+ per capacity); **shortage → exception, never auto-debt** (D-022).

**Exit:** full sell/collect/return and buy/pay/return cycles reconcile GL↔AR/AP↔stock (report tests); duplicate/retry posting impossible (idempotency tests); draft×posted×reversed invoice states behave spec (tests).

## Phase 4 — Representative workflow (van sales + offline) ✅ (completed 2026-10-15; evidence + residuals in PROGRESS.md session 5)

**Depends on:** Phase 3.

1. Rep provisioning: employee → role assign → **idempotent auto-created custody warehouse** (exactly one per rep; tested), permission scoping, device registration/revocation.
2. Transfer dispatch → rep accept/partial/discrepancy → accountant resolution (double-receive impossible — test).
3. Rep POS (PWA): catalog/customers/pricing cache, cash/credit/free-goods/returns, collections, expenses; e-payment states.
4. Offline core: IndexedDB outbox, stable op IDs + idempotency keys, push/pull sync API, backoff+jitter, conflict states, sync dashboard, offline limits (provisional defaults pending OQ-9), payload-immutability after accept.
5. Settlement workflow: request → reconciliation screen (all figures drillable) → accountant review → exceptions → approval → posting → immutable closure; notifications both ways (D-022).
6. Concurrency tests (two accountants finalize; oversell same stock offline×online), offline E2E (create sales offline → restart → reconnect → no duplicates).

**Exit:** representative-to-accountant day cycle works online & offline with zero duplicates; settlement closure reconciles cash/stock/e-payments; unapproved shortage creates no debt (test).

## Phase 5 — Manufacturing & advanced inventory ✅ (completed 2026-10-15; evidence + residuals in PROGRESS.md session 6)

**Depends on:** Phase 4.

1. BOMs/recipes (versioned), production orders/batches, planned vs actual consumption.
2. Material issue + finished-goods receipt at calculated cost (labor/overhead allocation per policy); WIP where configured; **zero-cost block** (D-009).
3. Normal/abnormal waste, scrap, damage; yield/variance reports; lot genealogy raw→finished→customer; expiry/recall report.

**Exit:** production posting reconciles with stock ledger & GL; variance math documented and tested; recall trace query returns full chain (test).

## Phase 6 — Electronic invoicing & tax compliance (ZATCA) — core ✅ / simulation ❗ partial (completed core 2026-10-15; portal automation & compliance-checks cycle pending; evidence in PROGRESS.md session 7)

**Depends on:** Phase 3 (invoices). OQ-2/OQ-3/OQ-4 legal inputs required before release claims.

1. Tenant tax identity config + validation (VAT no., CSID onboarding flow per official FATOORA process: compliance CSID → production CSID); sandbox/production environments separated.
2. XML (UBL 2.1 KSA profile) generation + validation, hashing, ICV chaining, QR TLV — implemented strictly from current official specs/SDKs; cryptographic material handling per D-024.
3. Clearance (standard) / reporting (simplified) flows, submission status history, retries without duplicate issuance, error classification & actionable diagnostics.
4. Credit/debit notes with original-invoice references; tax-period summaries & reconciliation reports; tax audit log.
5. Offline constraint enforcement per OQ-3 (standard invoices block offline issuance; simplified queue with reporting deadline per OQ-2).

**Exit:** sandbox onboarding + clearance + reporting + rejection-recovery demonstrated with evidence; **no production-compliance claims**; compliance gaps documented.

## Phase 7 — Reporting & dashboards

**Depends on:** Phases 2–6 data.

Implement REPORTING_SPECIFICATION.md catalog in priority order (GL/trial balance/statements → sales/distribution → inventory/production → tax), each with formula-verification test against seeded ledger data, filters (date range = `business_date`, branch/warehouse), drill-down to source docs, PDF/XLSX export, role-aware dashboards.

**Exit:** every report reconciles with authoritative ledgers (automated reconciliation tests); no double-counting under reversal fixtures.

## Phase 8 — Platform administration & backups ✅ (implemented 2026-10-16; evidence in PROGRESS.md Session 10, AC-030/033/037/038)

**Depends on:** Phases 1–6 exist to operate on.

1. `/platform` console: tenants, plans/entitlements, feature flags, quotas/metering, suspension/read-only expiry behavior (no history deletion).
2. Backup automation (4 h schedule, encryption, checksums, Drive upload w/ verification), retention (≥18 + optional GFS), stale-backup monitor, restore-runbook + isolated restore drill with evidence.
3. Platform health/jobs/backup dashboards, rate limits, break-glass support access (time-boxed, audited), tenant export/deletion workflows.

**Exit:** backup→verify→restore drill succeeds in isolation and is documented ✅ (7 invariants;
`pg_dump` path unavailable here → every run records the format it really used) · suspension
preserves read-only history ✅ (test; writes refused at transaction level, nothing deleted) ·
platform admin cannot read tenant financial data by default ✅ (test: platform queries select
identity/status/counts; reading content needs an approved grant) · console isolated from tenant
sessions ✅ (HTTP smoke + tests).

## Phase 9 — AI assistant

**Depends on:** Phase 7 (authoritative queries exist).

Provider adapters + per-tenant enablement; permission-aware read-only tool registry (sales_today, overdue_receivables, unsettled_reps, low_stock, expiry_soon, income_statement_summary, anomaly scan); approval-ticket flow for any action; prompt-injection guardrails; full conversation/tool audit; privacy data-minimization table implemented.

**Exit:** tools cannot cross tenant or permission boundaries (tests); model cannot mutate state without human approval (test); provider config isolated from core.

## Phase 10 — UX completion, hardening & release readiness

**Depends on:** all above.

RTL/bilingual sweep, accessibility audit (AA), status-semantics audit (never color-only), load/soak smoke, security review (authZ matrix re-verified), backup restore re-drill, full E2E acceptance run of TESTING_AND_ACCEPTANCE.md AC list, deployment & rollback runbook, operational runbooks, release-readiness report with evidence.

**Exit:** evidence-based release-readiness report; all OQ staffing/legal inputs resolved or explicitly scoped out.

---

### Phase-change checklist (apply at every transition)

- [ ] Acceptance criteria of the closing phase actually executed (not just written).
- [ ] Docs updated (any changed decision/contract/workflow).
- [ ] `docs/PROGRESS.md` appended with real command output.
- [ ] Validation gate green (`typegen`/`tsc`/`build`/`build_and_start`).
- [ ] No hidden critical defects; open defects listed in `PROGRESS.md`.
