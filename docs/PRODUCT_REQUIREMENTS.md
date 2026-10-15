# Product Requirements — Hisab ERP

Scope: multi-tenant cloud accounting/operations ERP for manufacturers, food factories,
wholesalers, distributors, and van-sales businesses. Language: Arabic-first (RTL),
English secondary; light + dark themes. Each requirement carries an ID referenced by
tests (`AC-###` in TESTING_AND_ACCEPTANCE.md) and the roadmap.

## 1. Personas

| Persona | Description | Home surface |
|---------|-------------|--------------|
| Platform Owner | SaaS operator; tenants, plans, backups, platform health | `/platform` console |
| Platform Ops Admin | Operations/monitoring; no tenant financial data by default | `/platform` console |
| Tenant Owner | Business owner; full tenant control, subscription view | ERP dashboard |
| Accountant / System Manager | Posting, periods, settlements, tax, pricing policy | ERP |
| Sales Manager | Sales oversight, price approvals, rep performance | ERP |
| Warehouse Manager | Receipts, issues, transfers, counts, quarantine | ERP |
| Production Manager | BOMs, production orders, costing, waste | ERP |
| Cashier | POS sales and receipts | ERP POS |
| Field Sales Rep | Van sales, custody, collections, settlement requests | Rep PWA (`/rep`) |
| Auditor | Read-only review and export | ERP |

## 2. Application 1 — Accounting & Operations ERP

### 2.1 Company & accounting foundations
- **FR-001** Company profile, branches, warehouses, fiscal years, accounting periods.
- **FR-002** Configurable currency, number/date formats, tenant time zone (default Asia/Riyadh).
- **FR-003** COA + account groups; tenant template seed; no arbitrary auto-creation of missing posting accounts — produce a blocking configuration error instead.
- **FR-004** Opening balances + controlled opening stock (approved, one-shot per account/warehouse, reversible only by reversal).
- **FR-005** General journal UI; balanced debit=credit enforced at DB + service level; draft→submit→approve→post workflow with permission tiers.
- **FR-006** Period close/reopen with authorization + full audit history; posting into closed periods impossible.
- **FR-007** Reversals and debit/credit adjustments; posted documents immutable (D-007).
- **FR-008** Financial dimensions: branch, warehouse, representative, cost center, project (where relevant) on journal lines.
- **FR-009** Configurable document numbering per series; posted numbers unique, never reused, assigned at posting time (D-005).

### 2.2 Customers & suppliers
- **FR-010** Profiles: contacts, addresses, tax registration, tax classification.
- **FR-011** Customer-specific effective-dated prices & discounts; credit limits, payment terms, credit holds; live outstanding balance.
- **FR-012** AR/AP aging, statements, receipts/payments with allocation, unallocated advances.
- **FR-013** Returns, credit notes, debit notes, documented adjustments.
- **FR-014** Duplicate detection (name/phone/tax-no.) and controlled merge with audit.

### 2.3 Products & units
- **FR-015** SKU, barcode, Arabic + English names, categories, brands.
- **FR-016** Purchase/sales/stock units with strict conversion factors; fractional quantities (kg) supported.
- **FR-017** Costing policy per product (WAC default); batch/lot + expiry tracking when enabled; min/max levels.
- **FR-018** Price lists + product tax classification; activation/discontinuation without deleting history.

### 2.4 Warehouses & inventory
- **FR-019** Multi-warehouse + locations; receipts, issues, inter-warehouse transfers.
- **FR-020** Transfer lifecycle: dispatch → in-transit → receive (full/partial/discrepancy) → acceptance/close; double-receive impossible.
- **FR-021** Reservations & availability checks; physical counts → adjustments; damaged/expired/quarantine stock with inspection outcomes.
- **FR-022** Movement history + valuation; batch traceability & expiry reporting; FEFO selection for expiry-tracked products.
- **FR-023** Negative stock prevented by default (exception = explicit config + permission, audited); concurrency-safe balance updates (row locks).

### 2.5 Manufacturing
- **FR-024** BOMs/recipes (versioned) with UoM conversions; production orders/batches.
- **FR-025** Planned vs actual consumption; raw-material issue + finished-goods receipt at computed cost; labor/overhead allocation when configured; WIP where required.
- **FR-026** Normal/abnormal waste; finished-product damage/scrap with ledger + GL effects.
- **FR-027** Yield & variance analysis; lot genealogy raw→finished→customer; expiry/recall support.
- **FR-028** Costing blocked (with explanation) when cost inputs or account mappings are missing; zero-cost production posting forbidden (D-009).

### 2.6 Sales, POS & invoices
- **FR-029** Two entry points (ERP POS + rep POS) sharing one authoritative invoice/pricing/stock/accounting/tax pipeline.
- **FR-030** Cash & credit sales; search by name/SKU/barcode; keyboard-first quantity entry; walk-in customers where permitted.
- **FR-031** Customer prices/discounts; free quantities; partial payments & multi-method (cash/bank/e-payment — e-payment tracked to settlement, not assumed cash).
- **FR-032** Returns, credit notes, approved corrections (reversal workflow); printable Arabic layouts; sales & collection history.
- **FR-033** Salesperson attribution & commission basis; line/invoice-level audit trail.
- **FR-034** Status search across all four dimensions: business / inventory / accounting / tax-submission (see INVOICING_AND_ZATCA.md §3).
- **FR-035** Save dialog with **Action A: Save & Post** (validate+post+e-invoice flow) and **Action B: Save draft** (no final effects, clearly labeled) — never a legal bypass (INVOICING_AND_ZATCA.md §5).

### 2.7 Pricing rules & free goods
- **FR-036** Admin-configurable: default price, min/max boundaries, customer/effective-dated prices, rep-specific policies, whether reps may exceed boundaries, override approval requirements, discount limits/approval tiers, free-goods policies with reasons & thresholds.
- **FR-037** Price entry never mutates the master price; every override records original price, actual price, discount, approver, user, time, reason.
- **FR-038** Free-goods lines explicit; stock + cost computed; accounting per D-021; VAT treatment from configured policy — never inferred from price=0.

### 2.8 Purchasing
- **FR-039** Purchase orders, goods receipts, supplier invoices (3-way match where PO used), purchase returns, supplier credit notes.
- **FR-040** Landed/additional costs; purchase price & quantity variance posting; payments/allocations/advances; balances & aging; document↔stock↔GL linkage.

### 2.9 Cash, banks & expenses
- **FR-041** Multiple cashboxes/bank accounts; transfers, receipts/payments, deposits/withdrawals.
- **FR-042** Bank reconciliation; e-payment transactions with settlement status tracked separately.
- **FR-043** Expenses + categories + attachments; approval limits & policies; rep cash custody; shortage/overage handled per documented adjustment flow (never automatic).

### 2.10 HR, payroll & commissions
- **FR-044** Employee records + link to user accounts/roles; salary structures/allowances; attendance/leave (basic); payroll periods, approvals, payslips.
- **FR-045** Advances & authorized deductions (legal compliance per OQ-5 — the system must not infer legal permission from a manager's approval alone).
- **FR-046** Commission rules per rep (calculation, adjustment, audit).
- **FR-047** Shortage-related employee receivables only after investigation + authorized approval (D-022); never auto-deducted from payroll.

## 3. Application 2 — Field Sales Representative App (PWA)

- **FR-050** Provisioning: employee exists → rep role → user account → permissions → **idempotent auto-created custody warehouse** (exactly one; repeated assignment creates none). Role removal preserves history and outstanding custody.
- **FR-051** Transfer dispatch notifications; receive with quantity comparison; accept/partial/discrepancy with reasons; discrepancies routed to accountant; double-receive impossible.
- **FR-052** Rep POS: customer & product search, customer pricing/credit rules, cash/credit, free goods, discounts/authorized overrides, returns/damaged recording, cash + supported e-payments, shareable/printable documents, visible invoice status + sync status.
- **FR-053** True offline-first (OFFLINE_SYNC.md): durable outbox, stable client IDs, idempotent retries, backoff+jitter, five explicit states, sync dashboard, restart/reboot recovery, conflict resolution by business rules, payload immutability after server accept, device registration/revocation, local data protection + session expiry.
- **FR-054** Offline limits: cached stock decremented locally & reconciled on sync; offline credit/invoice-count/value caps configurable; oversell/credit conflicts flagged on sync with a defined resolution (provisional defaults pending OQ-9).
- **FR-055** Offline tax constraints (INVOICING_AND_ZATCA.md §7): local drafts vs issued-pending-reporting vs clearance-required states; no fabricated stamps/QR/clearance; legally-questionable workflows flagged for review (OQ-2/OQ-3).

## 4. Settlement & shift closure
- **FR-060** Unique settlement request per rep → reconciliation screen (opening custody, receipts accepted, sales by product/invoice, free qty, returns, damaged/expired/missing, expected vs counted stock, cash sales & collections, credit balances, e-payments + settlement status, bank transfers, expenses + evidence, handover, unresolved items, discrepancies) — every figure drillable to source.
- **FR-061** Accountant review: counts, return/damage inspection, expense evidence, handover matching, e-payment reconciliation, receivables review, verified discrepancies, recount requests, approvals, escalation.
- **FR-062** Discrepancy policy (D-022): exception record first; adjustments only after investigation + authorized approval via configured mappings; surpluses documented too; no silent balance changes; no auto payroll deduction.
- **FR-063** Finalization gate: stock/cash reconciled or approved exceptions documented; e-payments resolved; expenses reviewed; pending ops handled; all postings succeed; row-level lock prevents double finalize (two concurrent accountants test); closure immutable except authorized reversal/adjustment; rep notified with results & references.

## 5. Tax & ZATCA
- **FR-070** Tax module per INVOICING_AND_ZATCA.md: registration/identity config, VAT status + effective dates, standard/simplified types, product tax categories & rates, inclusive/exclusive pricing where permitted, treatment of discounts/returns/free goods, missing-config blocking errors (no guessed rates, no silent exemption).
- **FR-071** FATOORA onboarding (compliance→production CSID), environments separated, certificates secured (D-024), XML per official spec, clearance (standard) / reporting (simplified), QR + cryptographic requirements, submission IDs/UUIDs/metadata/status history, retry-dedupe, error diagnostics, credit/debit references, period summaries, tax audit log.
- **FR-072** Seller status drives document behavior — an unregistered buyer never removes seller obligations.

## 6. Reports
- **FR-080** Catalog per REPORTING_SPECIFICATION.md: accounting (GL, TB, BS, IS, CF, journal, statements, aging, cash/bank, reconciliation, expenses, profitability, period comparison), sales & distribution, inventory & production, tax.
- **FR-081** Every report defines formula, sources, date semantics (business_date), treatment of drafts/reversals/voids; reconciles with authoritative ledgers; date/branch/warehouse filters; PDF/XLSX export; drill-down.

## 7. Backups & platform console
- **FR-090** Backup management (manual download; optional Drive upload; 4 h schedule; retention ≥18 latest ≈ 3 days + optional GFS; integrity checks; encryption; metadata incl. checksum/size/destination/status; retries + failure alerts; stale-backup monitor; documented restore + periodic drills).
- **FR-091** Platform console: tenant lifecycle (create/activate/suspend/deactivate), plans/licenses/renewals/limits, user/tenant counts, storage & usage monitoring, feature flags/entitlements, health & job monitoring, backup/recovery ops, integration status & alerts, audited limited support tools, platform audit log, rate limits, tenant export/deletion workflows with retention/legal compliance.
- **FR-092** Platform admins get **no** default access to tenant financial records; exceptional access is time-boxed, scoped, audited. Suspension never deletes history; expiry behavior preserves read-only/export per policy.

## 8. Roles & AI & UX
- **FR-100** Server-enforced RBAC with the 10 initial roles (brief §12) and granular permissions (view/create/edit-draft/post/approve/reverse/export/configure) + approval limits. Representative scope: assigned customers, custody warehouse, permitted products/actions only.
- **FR-101** Audit log events: permission changes, tax config, price overrides, stock adjustments, settlement approvals, journal reversals, sensitive exports, auth events, device registration/revocation.
- **FR-110** AI assistant (AI_ASSISTANT.md): multi-provider adapters; permission-aware server-side tools; read-only analytics v1; human approval for any mutation; no raw SQL; tenant isolation; prompt-injection defenses; data-minimization; disabled by default.
- **FR-120** UX (UX_AND_DESIGN_SYSTEM.md): Arabic-first RTL everywhere; professional typography; light/dark; responsive; AA accessibility + keyboard nav; role-appropriate dashboards; fast POS; actionable errors; consistent status vocabulary (never color-only); tenant-formatted numbers/dates/currency; correct Arabic print rendering; full state coverage (loading/empty/offline/syncing/success/failure); destructive confirmations; search/filters/saved views/pagination.

## 9. Non-functional requirements
- **NFR-001** Invariants INV-01…INV-17 (DOMAIN_MODEL.md §6) enforced via constraints, transactions, locks, idempotency, validation — and tested.
- **NFR-002** Decimal-only money math (D-003); UTC instants + tenant business_date (D-016).
- **NFR-003** Server-side authorization on every protected operation; client input never trusted (prices, totals, taxes, tenant IDs, stock).
- **NFR-004** Performance targets: POS line add < 100 ms local; invoice post < 2 s p95 online; sync batch of 100 ops < 10 s; report p95 < 5 s at reference data volume (to be set in Phase 7).
- **NFR-005** Availability of offline rep function ≥ 100% of core flows without network (within offline limits).
- **NFR-006** Recoverability: RPO 4 h (backup cadence), RTO target defined in BACKUP_AND_RECOVERY.md; restore drill evidence required before release.
- **NFR-007** Observability: structured logs, request IDs, job metrics, health endpoint incl. queue depth + backup freshness + sync error counts.

## 10. Out of scope (v1)
Multi-currency (OQ-10), native mobile apps, route optimization/GPS tracking, e-commerce storefront, fixed assets depreciation (post-v1), multi-company consolidation.

## 11. Acceptance criteria mapping
Every FR above maps to at least one `AC-###` scenario in TESTING_AND_ACCEPTANCE.md §3;
a phase is complete only when its mapped scenarios ran with recorded results (PROGRESS.md).
