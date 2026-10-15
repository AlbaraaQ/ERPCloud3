# Accounting Policy

Authoritative bookkeeping rules for every business event. Implemented exclusively by the
`PostingService` (D-006). Everything here is testable; deviations are defects.

## 1. Core rules

1. **Double entry, always balanced**: Σ debits = Σ credits per journal entry (INV-01), enforced by DB check + service validation. Decimal arithmetic only (D-003).
2. **Source-linked**: every journal entry references exactly one source document (`source_type, source_id`) + `effect_kind`; the triple is unique (INV-02) — retries return the original entry.
3. **Immutability**: posted entries/documents are never updated/deleted; corrections happen only via **reversal** entries (`reversal_of`, unique per original — INV-03/04) dated in an open period, followed optionally by a new corrected document.
4. **Periods**: no posting into closed fiscal periods (INV + D-005-family rules); reversal into a closed period posts to the **first open period** with explicit system note + audit.
5. **Numbering**: official document numbers assigned at posting time per series, gapless for posted docs, never reused (D-005).
6. **Dimensions**: branch, warehouse, representative, cost center, project recorded on journal lines where the source carries them.
7. **Configuration-first**: every posting resolves accounts from `posting_mappings`. A missing mapping → `ConfigurationError` (`"لم يتم إعداد حساب …"`) that **blocks posting**; the system never invents an account (INV-17).
8. **Rounding**: line-level HALF_UP to currency minor units; the rounding remainder, if any, posts to a configured rounding-difference account.

## 2. Fiscal calendar & dates

- `timestamptz` for instants; `business_date` (tenant TZ, default Asia/Riyadh — D-016) determines the fiscal period. Back-dating allowed only into open periods with permission; forward-dating into future periods is rejected.
- Period close: check-list (all drafts either posted or discarded per policy, reconciliations done) → close by authorized role → audit. Reopen requires higher permission + reason + audit; two reopen events trigger a platform-visible flag.

## 3. Chart of accounts — tenant template (structure)

| Code | Account | Type | Notes / used by |
|------|---------|------|-----------------|
| 1 | الأصول Assets | header | |
| 11 | الأصول المتداولة | header | |
| 1101 | الصناديق Cashboxes | control | per cashbox sub-accounts |
| 1102 | البنوك Banks | control | per bank account |
| 1103 | مدينون / ذمم العملاء AR | control | customer subledger reconciles (INV-08) |
| 1104 | المخزون Inventory | control | per warehouse valuation reconciles |
| 1105 | عُهد المندوبين النقدية Rep cash custody | asset | representative custody |
| 1106 | ض.ق.م — مشتريات (مدخلات) Input VAT | asset | tax module |
| 1107 | دفعات مقدمة للموردين Supplier advances | asset | |
| 1108 | مدينون متنوعون / سلف الموظفين Other receivables | asset | employee receivables, advances |
| 1109 | إنتاج تحت التشغيل WIP | asset | manufacturing (when enabled) |
| 2 | الالتزامات Liabilities | header | |
| 2101 | دائنون / ذمم الموردون AP | control | supplier subledger reconciles (INV-08) |
| 2102 | ض.ق.م — مبيعات (مخرجات) Output VAT | liability | tax module |
| 2103 | دفعات مقدمة من العملاء Customer advances | liability | |
| 2104 | مصروفات مستحقة Accrued expenses | liability | |
| 2105 | رواتب مستحقة Payroll payable | liability | |
| 3 | حقوق الملكية Equity | header | capital, drawings, retained earnings |
| 4 | الإيرادات Revenue | header | |
| 4101 | مبيعات Sales | revenue | net method w/ discount accounts below |
| 4102 | مردودات المبيعات Sales returns | contra-revenue | |
| 4103 | خصومات مسموحة Sales discounts | contra-revenue | |
| 5 | التكاليف والمصروفات | header | |
| 5101 | تكلفة البضاعة المباعة COGS | expense | sale issue cost |
| 5102 | بضاعة مجانية / عينات Free goods expense | expense | D-021 policy account |
| 5103 | فروقات التسوية المخزنية Settlement inventory adjustments | expense/(income) | approved shortages/overage |
| 5104 | هالك / تالف Scrap & damage | expense | normal scrap |
| 5105 | خسائر غير طبيعية Abnormal losses | expense | abnormal production waste |
| 5106 | مصروفات تشغيل Operating expenses | control | expense categories as sub-accounts |
| 5107 | فرق التقريب Rounding differences | expense/(income) | §1.8 |
| 5108 | عمولات المندوبين Rep commissions | expense | hr |
| 5201 | حساب تسوية الإنتاج Production clearing | clearing | = consumed − output − waste, must net to 0 |

*Template is seeded per tenant and editable (add sub-accounts); system **mapping keys**
below reference roles, not hard-coded account codes.*

## 4. Posting rules per business event

`Dr = debit · Cr = credit · accounts resolved by mapping key (missing → block, §1.7)`

| # | Event (effect_kind) | Entry (summary) | Notes |
|---|--------------------|-----------------|-------|
| P-01 | Sales invoice posted (cash) | Dr Cashbox (+ e-payment clearing if electronic) ; Cr Sales (net excl. VAT) ; Cr Output VAT | multi-method splits allowed; receivable path = P-02 |
| P-02 | Sales invoice posted (credit) | Dr AR : customer ; Cr Sales ; Cr Output VAT | hold/credit-limit validated pre-post (never here) |
| P-03 | COGS on sale | Dr COGS ; Cr Inventory (warehouse) | cost from StockLedgerService (WAC/FEFO lot, D-009); **same tx** as P-01/P-02 |
| P-04 | Free-goods line in invoice | Dr Free-goods expense (D-021) ; Cr Inventory ; VAT per configured policy — if treated as deemed supply (OQ-4): Dr Free-goods expense ; Cr Output VAT | revenue line stays 0; never silent exemption |
| P-05 | Sales return (goods back to stock) | Dr Sales returns (+ Dr Output VAT reversal amount) ; Cr AR/cash ; and Dr Inventory ; Cr COGS (original cost basis per policy) | references original invoice; qty never exceeds sold-minus-returned |
| P-06 | Credit note w/o goods | Dr Sales returns/discount (+VAT adj.) ; Cr AR | linked to original doc (ZATCA reference) |
| P-07 | Customer receipt + allocation | Dr Cashbox/Bank/E-payment clearing ; Cr AR (per allocation) ; excess → Customer advances | allocations ≤ outstanding (INV-09) |
| P-08 | E-payment settlement | Dr Bank ; Cr E-payment clearing (net) ; Dr Bank fees ; Cr E-payment clearing (fee) | invoice stays "electronic pending" until settled |
| P-09 | Purchase invoice | Dr Inventory (net) + Dr Input VAT + Dr Landed cost (to inventory) ; Cr AP : supplier | variance vs PO → purchase price variance asset/expense per config |
| P-10 | Purchase return | Dr AP (+Input VAT reversal) ; Cr Inventory (costed at receipt lot cost) | |
| P-11 | Supplier payment | Dr AP/advances ; Cr Bank/Cashbox | allocation rules = mirror of P-07 |
| P-12 | Inter-warehouse transfer (dispatch) | Dr Inventory:in-transit ; Cr Inventory:source | **no P&L**; cost = moving average carried |
| P-13 | Transfer acceptance | Dr Inventory:destination(or rep custody) ; Cr Inventory:in-transit | partial: remainder stays in-transit; discrepancy → P-14 |
| P-14 | Transfer discrepancy resolution (approved) | Dr/Cr Inventory:in-transit balance ; counterpart to Settlement-adjustments or designated investigation account until resolved | never auto-loss; exception-first |
| P-15 | Stock count adjustment (approved) | Dr/Cr Inventory ; counterparty Settlement-adjustments (3xxx stock adjustment mapping) | count document + approval required |
| P-16 | Quarantine/scrap write-off | Dr Scrap & damage (or Abnormal) ; Cr Inventory:quarantine | inspection outcome recorded |
| P-17 | Production material issue | Dr WIP (or Production clearing) ; Cr Inventory:raw (actual lot cost) | lot genealogy recorded |
| P-18 | Production finished-goods receipt | Dr Inventory:finished (computed unit cost) ; Cr Production clearing | cost = materials + allocated labor/overhead; zero-cost block (D-009) |
| P-19 | Labor/overhead allocation | Dr Production clearing ; Cr Accrued/payroll/overhead pools | per configured allocation basis (units/hours) |
| P-20 | Production scrap (normal) | Dr Scrap & damage ; Cr Production clearing | included in good-unit cost basis per policy; abnormal (P-21) excluded |
| P-21 | Abnormal waste | Dr Abnormal losses ; Cr Production clearing | never absorbed into unit cost silently |
| P-22 | Production variance close | Dr/Cr Production clearing → COGS or configured variance account | closes the order; clearing nets to 0 |
| P-23 | Expense (approved) | Dr Expense category ; Cr Cashbox/Bank/AP | evidence required over threshold |
| P-24 | Rep cash handover | Dr Cashbox:main ; Cr Rep cash custody : rep | part of settlement |
| P-25 | Settlement approved shortage (post-investigation) | Dr Settlement adjustments (or Employee receivable if approved per D-022) ; Cr Rep cash custody / Inventory:custody | exception-first; mapped accounts; audit |
| P-26 | Settlement approved overage | Dr Inventory/Cash custody ; Cr Settlement adjustments | documented, never silent |
| P-27 | Employee receivable (approved) | Dr Employee receivables ; Cr Settlement adjustments | **never** auto-posted before investigation; payroll deduction separate + legal check (OQ-5) |
| P-28 | Payroll accrual/pay | Dr Salaries & wages ; Cr Payroll payable (accrual) ; Dr Payroll payable ; Cr Bank (pay) | deductions only via authorized, legal-check-flagged lines |
| P-29 | Commission accrual | Dr Rep commissions ; Cr Accrued expenses | per commission rule run |
| P-30 | Customer advance receipt | Dr Cash ; Cr Customer advances | applies to invoices later via allocation transfer to AR |
| P-31 | Opening balances | Dr/Cr per balance ; counterparty Opening equity | one-shot, approval, audit |
| P-32 | Period-end VAT summary (informational) | report-level (no posting) unless filing adjustment configured | tax module |

## 5. Approval matrix (defaults — tenant-configurable per role)

| Action | Default permission |
|--------|-------------------|
| Post manual journal | accountant.post |
| Approve journal > limit | senior accountant approve (limit configurable) |
| Reverse posted document | accountant.reverse + reason |
| Close/reopen period | owner or delegated senior |
| Price override beyond boundary | sales manager approve (if policy requires) |
| Stock adjustment / scrap approval | warehouse manager + accountant |
| Settlement finalize | accountant.settle (row-locked) |
| Employee receivable posting | owner or delegated + legal flag (OQ-5) |
| Tax configuration change | tenant owner (audited) |

## 6. Reversal semantics

1. Reversal entries copy original lines with signs swapped, dated in current open period, `reversal_of = original`, unique.
2. Reversing an inventory-moving document also creates compensating stock movements at the original cost basis, subject to current availability policy (if stock no longer exists → block with actionable message; use adjustment workflow instead).
3. Reversed documents remain visible everywhere; reports include both (INV-13).
4. Tax-submitted invoices follow the tax workflow (credit note) instead of raw reversal — see INVOICING_AND_ZATCA.md §6.

## 7. Subledger reconciliation (continuous)

AR control = Σ customer open allocations · AP likewise · Inventory control = Σ warehouse valuations from stock ledger (job + report asserts equality nightly; drift → alert + investigation, never auto-fix).

## 8. Audit requirements

Every posting, reversal, period event, mapping change, and approval writes `audit_log` in the same transaction (D-018) with before/after where applicable.
