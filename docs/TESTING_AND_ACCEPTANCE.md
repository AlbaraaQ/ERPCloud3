# Testing & Acceptance

Testing is continuous, not a phase-end activity. No test is "passed" unless executed,
with the command + result recorded in `docs/PROGRESS.md`. Pre-existing failures are
distinguished from regressions explicitly.

## 1. Strategy

| Layer | Tool | Scope |
|-------|------|-------|
| Unit | Vitest | money math, rounding, pricing engine, state machines, zod schemas, conflict policies |
| Service/integration | Vitest + **ephemeral Postgres** (fresh schema per run) | PostingService, StockLedgerService, allocation engine, transfers, settlement, sync apply — with real constraints |
| DB/invariant | SQL-level tests | balanced-entry check, unique source keys, RLS policies, CHECK constraints, lock behavior |
| Concurrency | parallel-tx tests | two issues of last unit; double transfer accept; two settlement finalizes; replayed idempotency keys |
| API/security | Vitest + fetch handlers | sync push/pull, tamper reject, rate limits, authZ matrix |
| E2E | Playwright | login RTL shell; POS sale incl. save dialog; offline create → restart → reconnect → no duplicates; settlement day; platform suspension flow |
| Print/PDF | golden-file + visual smoke | Arabic rendering, copy labels, draft watermark |

Quality gate per change (CI-equivalent): `typegen` → `tsc --noEmit` → `eslint` → unit →
integration → `next build`. E2E before releases. Coverage target ≥ 80% lines for
`accounting`, `inventory`, `vansales` services (target, not yet measured).

## 2. Test environments

- Sandbox Postgres from `DATABASE_URL` is disposable; integration suites never run
  against it blindly — they create/drop their own schema (`test_<run_id>`).
- ZATCA: **sandbox environment only**, and only when official credentials exist;
  otherwise the adapter is covered by contract fakes and skipped-credential tests are
  marked as environment-limited (not "passed").

## 3. Acceptance scenarios (AC-ID → requirement refs)

| AC | Scenario | Type | FR/Ref |
|----|----------|------|--------|
| AC-001 | Create employee, assign rep role → exactly one custody warehouse created | int | FR-050 |
| AC-002 | Repeat role assignment / concurrent double-assign → still one warehouse | conc | FR-050, INV-07 |
| AC-003 | Dispatch transfer → rep notified; stock leaves source to in-transit | int | FR-051 |
| AC-004 | Full accept; partial accept; disputed accept with reasons → correct custody + in-transit remainder | int | FR-051 |
| AC-005 | Receive same transfer twice (retry) → single in-transit consumption | int/conc | INV-07 |
| AC-006 | Cash sale posts, GL balanced, stock issued, tax state correct | int | FR-030 |
| AC-007 | Credit sale respects limit/hold; over-limit blocked with Arabic message | int | FR-011/030 |
| AC-008 | Free-goods line: revenue 0, stock+cost out, expense posted; VAT per configured policy; no silent exemption | int | FR-038, D-021 |
| AC-009 | Customer/effective-dated price applied; min/max enforced | unit+int | FR-036/037 |
| AC-010 | Unauthorized override rejected; authorized override recorded with all audit fields | int+e2e | FR-037, FR-101 |
| AC-011 | Offline: create sales → restart app → reconnect → sync → **no duplicates** (docs, stock, journals) | e2e | FR-053, INV-02/05 |
| AC-012 | Retry storm: same op pushed 5× concurrently → one accepted, four ACKed-by-dedupe | conc | OFFLINE_SYNC §4 |
| AC-013 | Payload tamper after accept (same op_id, different hash) → reject + security audit | api | SECURITY §6 |
| AC-014 | Sync conflict (stock shortfall, credit breach) → conflict state + accountant routing, no wrong posting | int | OFFLINE_SYNC §6/7 |
| AC-015 | Settlement happy path: figures reconcile → approve → postings → close → immutable; rep notified | int+e2e | FR-060/061/063 |
| AC-016 | Shortage → exception only; unapproved shortage creates **no** employee debt / payroll deduction | int | FR-062, D-022 |
| AC-017 | Approved shortage → posting via configured mapping; audit complete | int | ACCT P-25/27 |
| AC-018 | Two accountants finalize same settlement concurrently → exactly one succeeds | conc | FR-063 |
| AC-019 | All journal entries balanced; reversals traceable & unique per original | inv | INV-01/03/04 |
| AC-020 | Posting into closed period rejected; reopen authorized + audited | int | FR-006 |
| AC-021 | Production: consume actual lot costs, allocate labor/overhead, compute output cost; zero-cost inputs blocked | int | FR-025…028, D-009 |
| AC-022 | Scrap (normal/absnormal) → correct accounts, no double-count; variance closes order | int | FR-026, P-20…22 |
| AC-023 | Lot genealogy: raw lot → batch → customer invoice; recall query complete | int | FR-027 |
| AC-024 | Invoice states: draft ≠ posted; returns capped; rejected → correction; reversed docs preserved | int+e2e | FR-034/035, INV-10/11 |
| AC-025 | ZATCA sandbox: onboarding → clearance (standard) → reporting (simplified) → forced failure → retry without duplicate issuance | int (env-limited) | FR-071 |
| AC-026 | Tax failure path: doc preserved with exact status; no fabricated stamp; Arabic diagnostics | int (fake adapter) | IZ §5 |
| AC-027 | Date boundaries: month-end across tenant TZ; business_date correctness | unit+int | D-016, INV-14 |
| AC-028 | Tenant isolation: cross-tenant read/write attempts fail at service + RLS level | sec | INV-16, SEC §2 |
| AC-029 | AuthZ matrix: every role × sensitive action (post/reverse/adjust/settle/config/export) | api | FR-100 |
| AC-030 | Backup: create → checksum → Drive upload (fake or real creds) → verify → restore to isolated DB → invariant checks | int (env-limited) | FR-090, BR §3/§5 |
| AC-031 | Reports reconciliations: TB footer, AR/AP ↔ control, valuation ↔ GL, VAT ↔ GL on seeded chaos fixture (incl. reversals) | int | FR-081, RL-1…5 |
| AC-032 | AI: tool permission gating; cross-tenant params neutralized; mutating intents require tickets; injection seed ignored | int | AI §3/§4/§7 |
| AC-033 | Suspension preserves read-only history; platform admin cannot read tenant ledgers by default | int | FR-091/092 |
| AC-034 | Rep offline limits enforced (count/value/credit/age) with correct block UX | int+e2e | FR-054, OS §6 |
| AC-035 | Reprint does not mutate doc/timestamps; copies labeled; draft watermark | unit+e2e | INV-12, IZ §8 |
| AC-036 | Session/device: expiry, revocation blocks sync, audit events present | api | SEC §3/§7 |

**Chaos fixture** (shared): seeded tenant with sales/returns/reversals/free goods/
transfers/partial receipts/discrepancies/expenses/settlement exceptions/production runs —
used by AC-019/031 and report tests so formulas are proven against messy real data.

## 4. Security & concurrency suites

Isolation (AC-028), authZ matrix (AC-029), tamper/replay (AC-013), rate-limit smoke,
session/revocation (AC-036), audit-hash verification; concurrency pack (AC-002/005/012/018
+ last-unit oversell). These suites are mandatory gates for Phases 1, 2, 4 respectively
and run forever after.

## 5. Definition of Done (per task)

Code + tests executed (results in PROGRESS.md) + docs updated if contract changed +
validation gate green + no hidden critical defects (known defects listed). A feature
whose tax/legal input is an OPEN OQ is "implemented, not release-claimed".
