# Domain Model

Ubiquitous language (Arabic terms are the UI source of truth), bounded contexts,
entities, relationships, and the 17 enforced invariants. Schema column-level design is
created per phase in `src/db/schema.ts`; this document defines meaning and rules.

## 1. Ubiquitous language (glossary)

| English | Arabic (UI) | Meaning |
|---------|-------------|---------|
| Tenant | المنشأة/المستأجر | A subscribed company space; hard isolation boundary |
| Journal entry | قيد يومية | Balanced double-entry record; immutable once posted |
| Posting | الترحيل | Making a document take accounting/stock effect |
| Draft | مسودة | Saved, non-final document; no GL/stock effect |
| Reversal | قيد عكسي | New entry negating a posted one; linked, unique per original |
| Fiscal period | فترة محاسبية | Posting time-box; closed periods reject postings |
| Stock ledger | سجل حركة المخزون | Append-only source of truth for stock |
| Custody (rep) | عُهدة المندوب | Stock/cash a representative is accountable for |
| Custody warehouse | مخزن المندوب | Auto-created warehouse per rep; idempotent |
| Transfer | تحويل مخزني | Stock movement between warehouses with transit states |
| Free goods | كميات مجانية | Explicit zero-price promotional lines |
| Price override | تجاوز سعر | Selling outside boundaries with approval/audit |
| Settlement | التسوية | Rep shift reconciliation & closure workflow |
| Shortage/overage | عجز / زيادة | Counted-vs-expected difference; exception-first |
| Simplified invoice | فاتورة ضريبية مُبسّطة | B2C tax invoice; ZATCA *reporting* flow |
| Standard invoice | فاتورة ضريبية | B2B tax invoice; ZATCA *clearance* flow |
| Credit/Debit note | إشعار دائن / مدين | Adjustment doc referencing an original invoice |
| Clearance / Reporting | المقاصة / الإبلاغ | ZATCA Phase 2 integration modes |
| Bill of materials | قائمة مكونات (BOM) | Recipe for producing a finished product |
| Scrap | هالك / تالف | Write-off of unusable materials/goods |
| FEFO | الأول انتهاءً أولاً صرفاً | Expiry-based batch issue policy |
| Cash custody | عهدة نقدية | Cash a rep holds until handover |
| Idempotency key | مفتاح منع التكرار | Unique op key making retries safe |

## 2. Bounded contexts & entities

### 2.1 Tenancy & identity
`tenants` (subscription anchor) · `companies` (legal/tax identity, base currency, time zone, formats) · `branches` · `platform_users` (console only) · `users` (tenant users) · `employees` (link user↔HR) · `roles`, `permissions`, `role_permissions`, `user_roles` (+ `approval_limits`) · `devices` (rep device registration, revoked_at) · `audit_log` · `notifications`.

### 2.2 Accounting
`fiscal_years`, `fiscal_periods` (status open/closed) · `accounts` (typed COA, groups) · `posting_mappings` (event→account, per tenant; missing = blocking error) · `journal_entries` (header: period, source ref, idempotency uniqueness, status, reversal_of) · `journal_lines` (account, debit, credit, dimensions: branch/warehouse/rep/cost_center/project) · `document_counters` (per series; posting-time assignment).

### 2.3 Item catalog & pricing
`products` (SKU, barcode, names AR/EN, tax_category, costing_policy, lot/expiry flags, active) · `categories`, `brands` · `units` + `product_units` (conversion to stock unit) · `price_lists`, `price_list_items`, `customer_prices` (effective-dated) · `representative_price_policies` (boundaries, mayExceed, approvalRequired).

### 2.4 Inventory
`warehouses` (type: main | branch | representative_custody | quarantine | in_transit virtual; `representative_id` unique nullable → exactly one custody warehouse per rep) · `stock_lots` (batch, expiry, unit cost, source doc) · `stock_ledger` (append-only movements w/ lot refs, source ref, idempotency uniqueness) · `stock_balances` (materialized; locked updates) · `transfers` + `transfer_lines` (dispatch/accept/partial/discrepancy state; line-level received_qty, discrepancy_reason) · `reservations` · `stock_counts` + lines → adjustments · `quarantine_cases` (inspection outcome: restock | scrap | return).

### 2.5 Sales & receivables
`customers` (terms, credit_limit, hold, tax registration) · `sales_invoices` + `sales_invoice_lines` (kind: normal | free | return_line; original_price, actual_price, discount, override fields) + 4 status dimensions (below) · `sales_returns` (or invoice type=return w/ reference — choose single model: `invoice_type ∈ {sale, sale_return}` with `original_invoice_id`) · `receipts` (multi-method lines) · `allocations` (receipt↔invoice, advance support) · `credit_notes`/`debit_notes` (tax documents referencing originals).

### 2.6 Purchasing
`suppliers` · `purchase_orders` + lines · `goods_receipts` + lines (lot creation point) · `purchase_invoices` + lines (3-way match data) · `purchase_returns` · `payments` (multi-method) · allocations to purchases/advances · `landed_costs`.

### 2.7 Cash & banks
`cashboxes`, `bank_accounts` · `cash_transactions` (receipt/payment/transfer/deposit/withdrawal) · `electronic_payments` (provider refs, status: initiated|authorized|settled|failed|reconciled) · `bank_reconciliations` + lines · `expenses` (category, evidence attachments, approval state, limit checks).

### 2.8 Manufacturing
`boms` + `bom_lines` (versioned) · `production_orders` (planned qty/schedule) · `production_batches` (actual run; lot assignments) · `production_consumptions` (ledger issue refs, actual lot cost) · `production_outputs` (receipt refs, computed unit cost) · `production_cost_components` (labor/overhead allocation) · `production_waste` (normal vs abnormal).

### 2.9 Van sales & settlement
`representatives` (employee 1:1; custody warehouse 1:1 lazy-created idempotently) · `van_sales_sessions` (device, day) · `settlements` (state machine; FOR-UPDATE finalize) + `settlement_lines` (per-product expected/counted/diff) + `settlement_cash_lines` + `settlement_exceptions` (shortage/overage/unresolved items w/ evidence, investigation, approval, posting ref) · `expense_claims` (rep-scoped expenses).

### 2.10 Tax / e-invoicing
`tax_configs` (seller identity, VAT no., env: sandbox|production, policy flags incl. free-goods treatment) · `tax_categories` + rates w/ effective dates · `zatca_certificates` (encrypted private key, CSID, expiry, env) · `invoice_submissions` (uuid, icv, hash, type, mode: clearance|reporting, status history JSONB or child table, request/response metadata, error class) — **never stores fabricated success** · `icv_counters` (per EGS).

### 2.11 Sync & outbox
`idempotency_keys` (key, device_id, tenant, op_type, payload_hash, result_ref, accepted_at — unique) · `sync_cursors` (per device high-watermark) · `outbox_events` (server-side fan-out for notifications) · client-side: Dexie tables `outbox`, `cache_*`, `meta` (see OFFLINE_SYNC.md §3).

### 2.12 Platform & operations
`plans` (entitlements JSONB, quotas) · `subscriptions` (status, renewal) · `feature_flags` · `usage_metrics` (periodic samples) · `backups` (artifact metadata: size, sha256, destination, status, verified_at) · `platform_audit_log` · `support_grants` (break-glass, time-boxed) · `jobs` (pg-boss internal) · `ai_provider_configs`, `ai_conversations`, `ai_tool_calls` (audit) · `ai_approval_tickets`.

## 3. Key relationships (core excerpt)

```mermaid
erDiagram
    TENANT ||--|| COMPANY : has
    TENANT ||--o{ USER : has
    USER ||--o{ EMPLOYEE : "may link"
    EMPLOYEE ||--o| REPRESENTATIVE : "is (role)"
    REPRESENTATIVE ||--o| WAREHOUSE : "custody (unique, idempotent)"
    WAREHOUSE ||--o{ STOCK_LEDGER : movements
    PRODUCT ||--o{ STOCK_LEDGER : moves
    STOCK_LOT ||--o{ STOCK_LEDGER : "moved via"
    TRANSFER ||--|{ TRANSFER_LINE : contains
    TRANSFER_LINE }o--|| WAREHOUSE : "from/to"
    SALES_INVOICE ||--|{ SALES_INVOICE_LINE : contains
    SALES_INVOICE }o--|| CUSTOMER : bills
    SALES_INVOICE ||--o| INVOICE_SUBMISSION : "tax state"
    SALES_INVOICE ||--o{ ALLOCATION : "settled by"
    RECEIPT ||--o{ ALLOCATION : allocates
    POSTING : "invoice/transfer/production/payment → journal_entries + stock_ledger (one tx)"
    JOURNAL_ENTRY ||--|{ JOURNAL_LINE : balanced
    JOURNAL_ENTRY }o--o| JOURNAL_ENTRY : "reversal_of (unique)"
    PRODUCTION_ORDER ||--o{ PRODUCTION_CONSUMPTION : consumes
    PRODUCTION_ORDER ||--o{ PRODUCTION_OUTPUT : yields
    SETTLEMENT ||--|{ SETTLEMENT_LINE : reconciles
    SETTLEMENT ||--o{ SETTLEMENT_EXCEPTION : "discrepancies"
    DEVICE ||--o{ IDEMPOTENCY_KEY : "ops from"
    TENANT ||--o{ SUBSCRIPTION : billed
```

## 4. Sales invoice — four orthogonal status dimensions (INV-10, INV-11)

| Dimension | Values |
|-----------|--------|
| `business_status` | draft → posted → (partially_returned / returned) → reversed (by doc) |
| `inventory_status` | none(draft) → issued → partially_returned → returned |
| `accounting_status` | none(draft) → posted → reversed |
| `tax_status` | not_applicable | local_draft | issued_pending_reporting | reported | clearance_pending | cleared | rejected | failed_retryable |

Rules: drafts have no GL/stock/tax effect and must never render as tax invoices;
reprints never mutate the doc or its timestamps (INV-12); tax lifecycle detailed in
INVOICING_AND_ZATCA.md §3–§6.

## 5. Value objects & numeric rules
`Money(amount NUMERIC(19,4), currency)` — decimal ops only, line-level HALF_UP rounding (D-003) · `Qty(NUMERIC(18,6), uom)` with conversion via `product_units` · `BusinessDate` (tenant TZ, D-016) · `IdempotencyKey(uuid)` · `DocumentNo` (series + counter, posting-time) · `LotRef`, `StatusEnum`s as DB enums/checks.

## 6. Enforced invariants (brief §15 → enforcement mechanism)

| INV | Statement | Enforcement |
|-----|-----------|-------------|
| 01 | Posted journal entries balance (Σdr=Σcr per entry, per currency) | DB `CHECK`/deferred trigger + service validation + test on every posting path |
| 02 | No financial op posts twice on retry | Unique `(tenant, source_type, source_id, effect_kind)` on journals & stock ledger; idempotency_keys table; unique doc numbers |
| 03 | Posted docs never silently edited/deleted | Status-machine guard + revoke UPDATE/DELETE on posted states (trigger) + audit |
| 04 | Reversals linked & unique per original | `reversal_of UNIQUE`, reversal posts its own balanced entry |
| 05 | No duplicate stock movements on sync retry | Same source-uniqueness + idempotency dedupe in sync apply |
| 06 | Custody & warehouse balances reconcile with movements | Same-tx materialization + nightly reconciliation job + report test |
| 07 | Transfers never received twice / never closed unresolved | Transfer state machine + `received_qty ≤ dispatched_qty` CHECK + unique accept event |
| 08 | AR/AP reconcile with subledgers | Allocation-only balance mutation; reconciliation report + invariant test |
| 09 | Allocations ≤ outstanding (else explicit advance/credit) | CHECK + service validation; advance accounts configured |
| 10 | Tax status separate from posting status | Orthogonal columns (§4); independent transitions |
| 11 | Drafts never mistaken for posted | Separate status; reports exclude drafts by default; UI badges |
| 12 | Printing never mutates | Print = read model + `print_events` log only |
| 13 | Reports treat reversals consistently, no double count | Reversal rows are first-class; report specs define inclusion |
| 14 | Time semantics documented | UTC + business_date everywhere (D-016) |
| 15 | Concurrency preserves all invariants | Row locks on balances/counters/settlements/transfer lines; serializable apply where needed; concurrency test-suite |
| 16 | Zero cross-tenant leakage | tenant_id everywhere + RLS + isolation tests + scoped sessions |
| 17 | Missing mappings/policies/approvals → explicit errors | Posting-mapping resolver throws typed `ConfigurationError`; UI surfaces actionable fix link |

## 7. Anti-corruption rule
No feature code computes GL/stock effects directly; all effects flow through
`PostingService` / `StockLedgerService` (D-006). Anything else is a defect.
