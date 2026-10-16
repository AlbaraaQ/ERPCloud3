# Hisab ERP — حِساب | Documentation Hub

**Hisab ERP** is a multi-tenant cloud accounting and operations platform for small and
medium-sized **manufacturers, food factories, wholesalers, distributors, and van-sales
businesses**. It combines three applications on one authoritative business core:

1. **Accounting & Operations ERP** — full double-entry accounting, inventory and costing,
   manufacturing, purchasing, sales/POS, cash and banks, HR/payroll, reporting.
2. **Field Sales Representative App (PWA)** — offline-first van-sales POS with custody,
   transfers, collections, and settlement.
3. **Platform Owner Console** — SaaS subscriptions, tenant lifecycle, backups,
   monitoring, and platform operations.

The UI is **Arabic-first, RTL, bilingual (Arabic default / English secondary)**, with a
polished light and dark mode.

> Working name: *Hisab ERP* («حِساب»). Final branding is an open product decision (see
> `DECISIONS.md`, OQ-6/OQ-7 for branding-adjacent questions).

---

## Documentation index

| # | File | Contents |
|---|------|----------|
| 1 | [PRODUCT_REQUIREMENTS.md](./PRODUCT_REQUIREMENTS.md) | Business requirements (FR/NFR), personas, acceptance criteria map |
| 2 | [DOMAIN_MODEL.md](./DOMAIN_MODEL.md) | Ubiquitous language, entities, relationships, 17 enforced invariants |
| 3 | [SYSTEM_ARCHITECTURE.md](./SYSTEM_ARCHITECTURE.md) | Modular monolith, module boundaries, sync boundary, jobs, deployment |
| 4 | [ACCOUNTING_POLICY.md](./ACCOUNTING_POLICY.md) | Chart of accounts, double-entry posting rules per business event, periods, reversals |
| 5 | [INVENTORY_AND_COSTING.md](./INVENTORY_AND_COSTING.md) | Stock ledger, warehouses, costing (WAC/FEFO), transfers, production costing |
| 6 | [VAN_SALES_WORKFLOW.md](./VAN_SALES_WORKFLOW.md) | Representative lifecycle, custody, transfers, settlement state machine |
| 7 | [INVOICING_AND_ZATCA.md](./INVOICING_AND_ZATCA.md) | Invoice state dimensions, save/post dialog semantics, ZATCA Phase 2 integration boundary |
| 8 | [SECURITY_AND_TENANCY.md](./SECURITY_AND_TENANCY.md) | Tenant isolation (3 layers), RBAC, audit, encryption, secrets |
| 9 | [OFFLINE_SYNC.md](./OFFLINE_SYNC.md) | Offline outbox, idempotency, sync protocol, conflict rules, offline limits |
| 10 | [REPORTING_SPECIFICATION.md](./REPORTING_SPECIFICATION.md) | Report catalog with formulas, sources, drill-down, reconciliation rules |
| 11 | [AI_ASSISTANT.md](./AI_ASSISTANT.md) | Provider adapters, permission-aware tool registry, approvals, privacy |
| 12 | [BACKUP_AND_RECOVERY.md](./BACKUP_AND_RECOVERY.md) | Backup policy (4h default), Google Drive, retention ≥18, restore drills |
| 13 | [PLATFORM_ADMIN.md](./PLATFORM_ADMIN.md) | Tenant lifecycle, plans/entitlements, quotas, monitoring, break-glass support |
| 14 | [UX_AND_DESIGN_SYSTEM.md](./UX_AND_DESIGN_SYSTEM.md) | Arabic-first RTL design system, themes, components, print templates |
| 15 | [TESTING_AND_ACCEPTANCE.md](./TESTING_AND_ACCEPTANCE.md) | Test strategy, AC-### acceptance scenarios, quality gates |
| 16 | [IMPLEMENTATION_ROADMAP.md](./IMPLEMENTATION_ROADMAP.md) | Phases 0–10, dependencies, exit criteria, current pointer |
| 17 | [DECISIONS.md](./DECISIONS.md) | ADR-style decisions (D-###), assumptions (A-#), open questions (OQ-#) |
| 18 | [PROGRESS.md](./PROGRESS.md) | Session-by-session implementation status — **read this first** |
| 19 | [OPERATIONS_GUIDE.md](./OPERATIONS_GUIDE.md) | **دليل التشغيل والاستخدام (بالعربية)** — how to run the system and use every module, day to day |
| 20 | [RUNBOOK.md](./RUNBOOK.md) | Operator runbook: deploy, rollback, routine jobs, alert semantics, incident playbooks |
| 21 | [RELEASE_READINESS.md](./RELEASE_READINESS.md) | Phase 10 evidence-based release report: gates, coverage, blockers, verdict |

---

## Current phase

**Phase 10 — UX completion, hardening & release readiness (in progress)** on top of
Phases 0–9 ✅ complete: accounting/inventory/sales/purchasing/cash/van-sales/manufacturing,
reporting (R-01…R-66 catalog), ZATCA Phase-2 flow (sandbox-validated architecture only —
AC-025, **not** production-certified, OQ-2/3/4 open), platform administration + backups,
and the AI assistant with its retention and metering.

Phase 10 evidence so far: `npm test` **21 files / 184 passed / 8 skipped / 0 failed**,
`tsc` clean, `next build` ok, `npm run acceptance:sweep -- --soak=20` **39/39 checks
passed** (every screen + session-namespace isolation + smoke), a fresh
backup → verify → restore drill, and a structural guard suite that fails the build if a
screen loses its server-side guard. Read the verdict and the ranked blockers in
[RELEASE_READINESS.md](./RELEASE_READINESS.md); operators start at
[OPERATIONS_GUIDE.md](./OPERATIONS_GUIDE.md) (Arabic) and [RUNBOOK.md](./RUNBOOK.md).

## How to resume work (session protocol)

At the start of **every** working session:

1. Read `docs/README.md` (this file), `docs/PROGRESS.md`,
   `docs/IMPLEMENTATION_ROADMAP.md`, and `docs/DECISIONS.md`.
2. Inspect the repository working tree and recent changes.
3. Verify the actual code/tests match what `PROGRESS.md` claims. Never trust the claim
   without verification.
4. Resume from the next incomplete roadmap task; do not redo verified work.

At the end of **every** session:

- Update `docs/PROGRESS.md` with: completed tasks, files changed, commands actually run
  with their real results, unresolved defects, migration status, and the exact next step.
- Update any doc whose decision/contract/workflow changed. A task is not "done" because
  code was written — only when it is tested, documented, and validated.

## Repository state at Phase 0 (assessment summary)

- Starter template: Next.js 16 (App Router, Turbopack), React 19, TypeScript (strict),
  Drizzle ORM + `pg` (node-postgres Pool), Tailwind CSS v4, PostgreSQL via `DATABASE_URL`.
- Pre-existing code retained as-is: `src/db/index.ts` (pool/db client),
  `src/db/schema.ts` (empty placeholder), `src/app/api/health/route.ts` (DB healthcheck),
  `drizzle.config.json`, Tailwind/PostCSS wiring.
- **No migrations, no domain tables, no auth, no tests, no UI components** existed.
  Nothing user-authored required preservation; the DB is an empty disposable sandbox.
- Baseline validation (Phase 0 evidence): `next typegen` ✓, `tsc --noEmit` ✓ (0 errors),
  `next build` ✓. Full details in `PROGRESS.md`.

## Technology snapshot (canonical decisions live in DECISIONS.md)

PostgreSQL 16 · Drizzle ORM · Next.js App Router modular monolith · Server Actions +
Route Handlers over shared application services · pg-boss job queue · PWA (Dexie/IndexedDB
outbox + service worker) for the rep app · decimal arithmetic for money (never binary
floats) · shared-schema multi-tenancy with `tenant_id` + Postgres RLS defense-in-depth.

## Guiding principles (apply to every phase)

Accounting correctness, inventory accuracy, data integrity, tenant isolation,
recoverability, and regulatory compliance take priority over feature speed. Every
financial/stock effect traces to a source document. Missing configuration (accounts, tax
policy, costing inputs, approvals) produces explicit blocking errors — never silent
defaults.
