# Reporting Specification

Every report below states: **sources**, **formula**, **filters**, **draft policy**,
**reversal handling**, **drill-down**. Universal rules first.

## 0. Universal rules

- Sources are the authoritative tables only: `journal_entries/lines`, `stock_ledger/balances`, invoice/receipt/allocation tables, `invoice_submissions`. **Reports never sum duplicate representations** (e.g., never add both invoice totals and journal lines to the same figure) — each report names its single source of truth (INV-13).
- Date semantics: filters apply to `business_date` (tenant TZ, D-016) unless "as of instant" is stated.
- Drafts are **excluded** by default; a visible "include drafts" toggle (where offered) labels output accordingly.
- Reversals: reversal entries are first-class rows; P&L-style reports naturally net them; document lists show both with a "عكسي/Reversed" badge. Voided-before-post docs appear only in audit-style listings.
- Exports: **CSV and XLSX are implemented** (`/reports/export`, same dispatcher as the
  screen, `reports.export` enforced, `reports.exported` audited); the XLSX sheet is RTL and
  keeps money numeric. **PDF remains open** — Arabic-correct rendering needs a
  shaping/font-subsetting renderer that the dependency set does not provide (residual in
  PROGRESS Session 9). Drill-down links appear only where the viewer has document-level
  permission.
- **Subledger documents are read from the postings, never guessed (Phase 7, binding).** The
  AR/AP document set is exactly the set of `journal_entries.source_id` whose **posted lines
  touched the resolved control account** (`postingMappings` key → account, code only as a
  fallback — never a hard-coded id), with each document's sign taken from **its own
  posting** (debit-heavy ⇒ it increased the subledger). Allocations are then subtracted, so
  `Σ signed documents − Σ allocations = control-account balance` holds **by construction**
  (RL-2). Deriving the set from `is_credit`/`customer_id`/`invoice_type` alone was tried and
  drifts whenever a walk-in sale debits AR or a credit note reverses one — do not go back.
- **Maturity/aging of undated documents:** a document with no `due_date` is shown in the
  `current` bucket and the report carries a note with the count, so the reader knows the
  bucket is a convention and not data.
- **A breach must explain itself.** Every failed RL assertion carries a note naming the
  responsible records (e.g. stock movements with **no journal effect on the inventory
  control account**, posted documents with VAT and no journal entry), including the key
  figures — never a bare delta. Diagnostics run only when a check actually fails.
- **Coverage over fabrication.** When the data a figure needs does not exist (missing cost,
  no statement import, no captured override attempt), the report prints a coverage banner
  and withholds the derived percentage instead of emitting a plausible number; catalog
  entries whose sources are absent are `pending` with a stated reason and render no numbers.

## 1. Accounting reports

### R-01 General Ledger (دفتر الأستاذ العام)
- Source: posted journal lines + entry headers.
- Formula: per account, running balance over date range (opening = Σ lines before range).
- Filters: date range, account(s), branch/warehouse/rep/cost-center/project.
- Drill: line → journal entry → source document.

### R-02 Trial Balance (ميزان المراجعة)
- Source: same. Formula: per account Σdr, Σcr, net balance in range (+ opening/closing columns). Footer totals must be equal (Σdr=Σcr) — assertion displayed; inequality = invariant breach alert.

### R-03 Balance Sheet (الميزانية العمومية)
- Mapping: account → BS node via configured report-mapping. Formula: closing balances at date. Assets = Liabilities + Equity check displayed.

### R-04 Income Statement (قائمة الدخل)
- Source: revenue/expense accounts in range. Includes COGS, returns/discounts nets, free-goods expense (D-021), settlement adjustments, scrap/losses, commissions. Drill to account → GL.

### R-05 Cash Flow (قائمة التدفقات النقدية)
- Method: indirect (derived from cash/bank account journal lines classified by counter-account mapping). Assumption documented; direct method post-v1.

### R-06 Journal Report · R-07 Account Statement (كشف حساب)
- Journal report: chronological entries w/ filters (source type, user, period).
- Statement: any account incl. customer/supplier subledger — opening, lines, running balance.

### R-08 AR/AP Aging (أعمار الذمم)
- Source: open allocations on posted docs. Formula: outstanding = doc total − allocated; bucket by due_date vs business_date (current/1–30/31–60/61–90/90+). Reconciliation: Σ per control account must equal R-07 balance (assert + display).

### R-09 Cash/Bank Balances · R-10 Bank Reconciliation
- Balances: from journal lines on 1101/1102 control trees, per cashbox/account, as of date. Reconciliation: statement lines vs cash_transactions; outstanding lists (deposits in transit, unsettled e-payments shown distinctly — never as cash).

### R-11 Expense Analysis
- Source: posted expense docs/journals. Group by category/branch/rep; trend vs prior period.

### R-12 Profitability (by product/customer/branch/rep)
- Revenue (net of returns/discounts) − COGS − allocated free-goods cost; **only when cost data is complete** — otherwise the report shows a coverage banner ("تكلفة غير مكتملة لـ X% من البنود") instead of fake margins (INV-17 spirit).

### R-13 Period Comparison — as R-02/R-04 with N period columns + Δ%.

## 2. Sales & distribution reports

| ID | Report | Key formula / notes |
|----|--------|---------------------|
| R-20 | Sales by date/product/customer/branch/rep | posted invoice lines (ex-free revenue; free shown separately as qty + cost) |
| R-21 | Cash vs credit sales | payment behavior on posted invoices; outstanding from allocations |
| R-22 | Returns & discounts | returns docs + line discounts; % of gross |
| R-23 | Free goods | qty + cost by product/rep/reason (D-021 expense source) |
| R-24 | Price overrides & attempts | accepted overrides (user, approver, margins vs boundary) + rejected attempts count |
| R-25 | Customer collections | receipts by method/day/rep; e-payments listed with settlement state |
| R-26 | Outstanding receivables | R-08 detail by rep/branch |
| R-27 | Rep performance & commission | sales/collections/returns ratios; commission per configured rule (Phase 4) |
| R-28 | Rep custody & settlement history | per settlement: opening→movements→closing, exceptions, approvals |
| R-29 | Shortages/overages & unresolved discrepancies | open `settlement_exceptions` aging + status |
| R-30 | Route/visit reports | only if route features enabled (out of v1 scope markup) |

## 3. Inventory & production reports

| ID | Report | Key formula / notes |
|----|--------|---------------------|
| R-40 | Stock on hand & availability | balances = ledger-derived; on_hand, reserved, available per warehouse/lot |
| R-41 | Movement ledger | stock_ledger listing w/ running qty; drill to source doc |
| R-42 | Inventory valuation | qty × policy cost (WAC/FEFO lot cost); total asserts = GL inventory control (P-07 §7) |
| R-43 | Slow/non-moving | last issue date per product/warehouse; thresholds configurable |
| R-44 | Low stock alerts | available < min (configurable per warehouse) |
| R-45 | Batch & expiry | lots w/ expiry bands 30/60/90; expired list + quarantine linkage |
| R-46 | Damaged/expired stock | quarantine movements & outcomes (scrap vs restock) |
| R-47 | Production output & yield | actual/planned qty; yield% |
| R-48 | Raw material consumption | planned vs actual per order/product; variance qty & value |
| R-49 | Scrap & waste analysis | normal vs abnormal; value by reason/product/order |
| R-50 | Manufacturing cost & variance | absorbed vs actual per order; P-22 closure evidence |
| R-51 | Traceability & recall | lot genealogy raw→output→customer invoices; reverse lookup customer→lots |

## 4. Tax reports

| ID | Report | Source & formula |
|----|--------|------------------|
| R-60 | Taxable sales by rate/category | posted invoices grouped by tax category/rate; net + VAT sums tie to R-04 output VAT |
| R-61 | Output vs input VAT summary | output from sales/credit notes; input from purchases; net payable indication (filing itself is external) |
| R-62 | Submission status ledger | invoice_submissions grouped by state (pending/reported/cleared/rejected/failed) w/ age |
| R-63 | Rejected/failed detail | error class, message, retry count, age → action queue |
| R-64 | Credit/debit note references | notes w/ original refs + statuses |
| R-65 | Tax-period reconciliation | Σ invoice VAT ↔ GL 2101/2102 control movement; Δ explained (pending submissions etc.) |
| R-66 | ZATCA integration audit | certificate events, onboarding, env, submission attempt log (audited export) |

## 5. Reconciliation assertions surfaced in-app

RL-1 TB footer equality (each run) · RL-2 AR/AP subledger ↔ control (R-08) · RL-3
valuation ↔ GL (R-42) · RL-4 custody balances ↔ ledger (settlement reports) · RL-5 VAT
report ↔ GL (R-65). Any breach renders a visible integrity banner + platform alert;
reports must not silently mask drift.

## 6. Performance & UX notes

Reference volumes & p95 targets per NFR-004; heavy reports run via job queue w/
progress; index plan per report created with implementation; saved views (filters)
per user; large lists paginated server-side; print templates share DESIGN tokens
(UX_AND_DESIGN_SYSTEM §8).
