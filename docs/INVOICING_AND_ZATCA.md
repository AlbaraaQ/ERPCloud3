# Invoicing & ZATCA Tax Compliance

> **Compliance rule (D-012):** this document defines the *boundary and behavior*. Exact
> ZATCA endpoints, XML fields, cryptographic steps, waves, and deadlines **must be
> implemented from the current official ZATCA/FATOORA developer documentation at
> implementation time (Phase 6)**. Nothing here invents API details, and the product
> must never claim production compliance from a successful sandbox call.

## 1. Document types

| Type | Use | ZATCA Phase 2 mode |
|------|-----|--------------------|
| Standard tax invoice (B2B) | registered buyers | **Clearance** — invoice becomes valid only after platform clearance response; sharing before clearance is non-compliant |
| Simplified tax invoice (B2C / below threshold) | consumers, POS, van sales | **Reporting** — issued by the EGS, must be reported to ZATCA integration within the officially allowed window |
| Credit note / Debit note | returns, adjustments | same mode as the referenced original; must carry original-invoice reference(s) |
| Non-tax commercial document | drafts/quotes when tax not applicable | no submission; clearly labeled "not a tax invoice" |

Seller obligations derive from the **seller's** tax status + transaction type + law +
tenant compliance policy — an unregistered buyer never removes seller duties (FR-072).

## 2. Prerequisites (block issuance when missing → ConfigurationError)

- Tenant tax config: legal name, VAT registration number, CR, address; VAT status + effective date.
- FATOORA onboarding per environment: CSR → compliance CSID → **production CSID (pCSID)**; certificate + private key stored encrypted outside source control (D-024); sandbox ≠ production credentials.
- Product invoice tax category + rate per item (effective-dated); inclusive/exclusive pricing policy; free-goods VAT policy flag (OQ-4); e-invoicing wave applicability per tenant (OQ-8).
- If any prerequisite is missing for a document that legally requires e-invoicing: **block final posting** (INV-17). A draft may still be saved but is labeled non-final and cannot be shared/printed as an invoice.

## 3. Status taxonomy (per invoice — `tax_status`, orthogonal to business/accounting, DOMAIN_MODEL §4)

| Status | Meaning | Allowed transitions |
|--------|---------|---------------------|
| `local_draft` | saved locally/offline; **not issued**; no submission data | → issued_pending_reporting (synced simplified) · → blocked (standard while offline, OQ-3) · → deleted draft allowed pre-issuance |
| `issued_pending_reporting` | simplified invoice issued (signed locally per EGS rules incl. QR), awaiting reporting | → reported · → failed_retryable · → rejected |
| `clearance_pending` | standard invoice submitted for clearance | → cleared · → rejected · → failed_retryable |
| `reported` / `cleared` | accepted by ZATCA platform | terminal; corrections only via credit/debit notes |
| `rejected` | ZATCA rejection with errors | → correction workflow (new doc + references); status kept forever |
| `failed_retryable` | transport/5xx/timeout | retry with **same UUID/ICV/version** — never re-issue |
| `not_applicable` | non-tax docs / drafts after policy decision | — |

Never fabricate acceptance: statuses change only from **recorded platform responses**
(or explicit legal failover documented per official rules). Every attempt is journaled
in `invoice_submissions` with request/response metadata, timestamp, and error class.

## 4. Invoice chain integrity

- Per-EGS `uuid` (v4 per official spec), `icv` (monotonic per EGS counter, D-005), document hash computed per official algorithm, chaining to previous hash — replay/reorder attempts detected on retry.
- ICV/counter assignment happens inside the posting transaction (row-locked), so **retry = same document, same UUID/ICV/hash** (INV-02). Double-submission protection: unique `(tenant, invoice_id, attempt_kind)` plus `invoice_submissions` op keys.
- QR code: TLV-structured per official simplified-invoice requirements (standard after clearance carries its own mandated artifacts). Printed only from generated invoice data — never hand-made.

## 5. The Save dialog (both POS entry points — binding UX contract)

Pressing **حفظ (Save)** opens a simple Arabic dialog with two primary actions (extensible later):

### Action A — حفظ وترحيل (Save & Post)
1. Validate: permissions, stock availability (locked check), pricing boundaries & override approvals, customer rules (credit limit/hold/terms), payment details, tax prerequisites (§2).
2. Persist document + lines + post inventory & accounting (P-01…P-05) **atomically** (one tx with ledger writes + audit + number assignment).
3. Execute the required e-invoicing flow by type: standard → clearance submit (status `clearance_pending`); simplified → issue + mark `issued_pending_reporting` (report job).
4. Print according to **actual state**: cleared standard → tax invoice copies (+cryptographic stamp/QR); pending-reported simplified → printed copy marked exactly per official rules; **uncleared standard → never presented as cleared** (§8).
5. Record results + audit. If ZATCA fails: document remains with exact status
   (`clearance_pending`/`failed_retryable`/`rejected`), retry allowed without duplication —
   **failure never silently becomes success, and retry never creates a new invoice.**

### Action B — حفظ بدون ترحيل (Save Draft)
- Saves `business_status=draft, tax_status=local_draft`; no GL/stock effects (no reservation unless policy config explicitly enables one); cannot be printed/shared as an invoice; authorized review → later post through Action A equivalent. Edits allowed only pre-post; full audit of edits.
- **These actions are UX choices, not legal bypasses.** A taxable transaction that must be e-invoiced stays bound to the correct issuance workflow; drafts must not be used to conceal issued supplies (block: draft printouts carry "مسودة – ليست فاتورة ضريبية").

## 6. Corrections after acceptance

Accepted invoices are corrected **only** via credit/debit notes referencing the original
((invoice reference, uuid, ICV) as required by official spec), submitted through the same
clearance/reporting mode. Raw accounting "reversal" is forbidden on tax-accepted docs.

## 7. Offline behavior (with OFFLINE_SYNC §6)

| Situation | Behavior | Legal status |
|-----------|----------|--------------|
| Simplified invoice offline | May continue issuing per EGS rules using local chain; queue as `issued_pending_reporting`; report immediately upon connectivity within the allowed window; display + enforce a deadline countdown | **FLAGGED OQ-2** — must be confirmed against current official allowance & tenant wave before release |
| Standard invoice offline | **Cannot be validly issued** (clearance requires connectivity): record as `local_draft` only; block printing/sharing as an invoice; complete issuance on reconnect | **FLAGGED OQ-3** — business must accept this block |
| Retry after failure | same op identity; dedupe server-side; backoff | — |
| Any state | offline never grants unlimited stock/credit (OFFLINE_SYNC §6) | — |

## 8. Printing rules

- Configurable templates: customer copy / acknowledgment copy (signature fields) / internal.
- Must show: document type & exact status; sale date-time; **print date-time** (reprints change only print time display, never the document); lines with quantities and **free quantities**; totals incl. VAT breakdown; payment breakdown; outstanding balance; customer + representative/branch info; original-invoice reference on returns/credit notes; QR/cryptographic elements exactly as issued.
- "فاتورة ضريبية" wording appears **only** when the document qualifies (cleared standard / properly issued simplified per official rules). Reprints are events in `print_events` and never mutate the document (INV-12).

## 9. Configuration & failure UX

Missing tax prerequisites → actionable Arabic errors with deep link to the exact setting
("يجب إعداد الرقم الضريبي قبل ترحيل الفواتير"). ZATCA errors are classified
(validation / connectivity / auth / platform) and shown with the official message +
suggested fix; rejected invoices surface per-line/per-field causes.

## 10. Reporting hooks

Tax-period summaries: taxable sales by rate/category, output/input VAT, submission
status ledger (issued/reported/cleared/rejected/failed), credit-note references,
reconciliation invoice count/value vs GL (REPORTING_SPECIFICATION §6).

## 11. Audit & access

Onboarding, certificate ops, config changes, every submission attempt+result, and manual
interventions are audited (D-018). Tax settings restricted to tenant owner role; exports
of submission logs are audited sensitive exports.
