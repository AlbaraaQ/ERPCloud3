# System Architecture

## 1. Shape: modular monolith (D-001)

One Next.js (App Router) application, single production build, one PostgreSQL database.
Modules are **enforced code boundaries**, not processes. Extraction into services is
possible later along these seams, but is not a v1 goal.

```mermaid
flowchart TB
    subgraph Clients
        WEB[ERP Web App<br/>Arabic-first RTL]
        PWA[Rep PWA /rep<br/>offline-first]
        CONSOLE[Platform Console /platform]
    end
    subgraph Next.js["Next.js App (single deployable)"]
        UI[Route groups & RSC UI<br/>app/(app) · app/(rep) · app/(platform)]
        SA[Server Actions<br/>web mutations]
        API[Route Handlers<br/>/api/sync/* · /api/webhooks/* · /api/health]
        subgraph Modules["src/modules (no cycles; deps point inward)"]
            direction LR
            SALES[sales] --> KERNEL[shared kernel]
            PURCH[purchasing] --> KERNEL
            MFG[manufacturing] --> KERNEL
            VANS[van-sales] --> KERNEL
            TAX[tax/zatca] --> KERNEL
            INV2[inventory] --> KERNEL
            ACCT[accounting] --> KERNEL
        end
        WORKER[In-process job worker<br/>pg-boss queues]
    end
    DB[(PostgreSQL<br/>RLS + constraints)]
    DRIVE[(Google Drive)]
    ZATCA[(ZATCA FATOORA)]
    AI[(AI providers)]

    WEB & PWA & CONSOLE --> UI
    UI --> SA
    PWA --> API
    SA & API --> Modules
    Modules --> DB
    WORKER --> DB
    WORKER --> DRIVE
    TAX --> ZATCA
    Modules --> AI
```

## 2. Module map & dependency rules

```
src/
  app/                    # routing only — zero business logic
    (app)/...             # ERP screens (dashboard, pos, invoices, inventory, ...)
    (rep)/...             # rep PWA screens + manifest + SW registration
    (platform)/...        # platform console
    api/health|api/sync/|api/webhooks/...
  modules/
    shared/               # kernel: Result/DomainError, Money, Qty, BusinessDate,
                          # IdGenerator, audit(), tx() helper, permissions DSL,
                          # posting-mappings resolver, pino logger, zod schemas
    tenancy/  identity/   # tenants, companies, users, roles, sessions, devices
    accounting/           # COA, periods, PostingService, journals, reversals
    inventory/            # StockLedgerService, balances, transfers, reservations, lots
    catalog/              # products, units, price lists, customers/suppliers live in parties/
    parties/              # customers, suppliers, credit rules, allocation engine
    sales/                # invoice doc model, pricing engine, POS commands, save dialog flows
    purchasing/ cash/ hr/ # per DOMAIN_MODEL
    vansales/             # provisioning, custody, settlement state machine, sync apply handlers
    manufacturing/ tax/ reporting/ ai/ platform/ notifications/ jobs/ backup/
```

**Rules**
1. `app/` imports modules; modules never import from `app/`.
2. Feature modules import only the **public surface** (`index.ts`) of other modules and always may import `shared/`.
3. GL/stock effects only via `accounting.PostingService` / `inventory.StockLedgerService` (D-006) — enforced by code review + dependency lint (eslint no-restricted-imports) + invariant tests.
4. No cross-module DB table writes; modules own their tables (Drizzle schema files per module, aggregated in `src/db/schema.ts`).

## 3. Request paths

| Path | Who | Notes |
|------|-----|-------|
| Web UI mutations | Server Actions | Call application services inside `db.transaction`; revalidate; every action → `requirePermission()` at service entry |
| Rep sync | `POST /api/sync/push`, `POST /api/sync/pull` | Device-authenticated; idempotency-key dedupe; per-op apply in its own tx; batch results per op (ack/reject/conflict) — never fail the whole batch for one bad op |
| Webhooks | e-payment providers, (Drive) | Signature verification; enqueue processing job; return fast |
| Health | `/api/health` (exists — keep & extend) | DB ping + queue depth + last-successful-backup age + sync error count |
| Jobs | pg-boss worker started with server | queues: `mail`, `backup`, `reconcile-stock`, `zatca-retry`, `usage-meter`, `notify`; retry w/ backoff; dead-letter surfaced in console |

## 4. Transactions & consistency patterns

- **Unit of work**: `shared.tx(async (trx) => …)` wraps Drizzle transactions; services compose within one tx (document insert → ledger effects → audit → notification enqueue in same tx).
- **Idempotency**: every effect table has `(tenant_id, source_type, source_id, effect_kind)` unique; retries hit the unique key and return the original result (INV-02/05).
- **Locking**: `FOR UPDATE` on stock balance rows (issue/adjust), document counters (numbering), settlement row (finalize), transfer line rows (receive). Ordered lock acquisition (warehouse balance → counter → settlement) to avoid deadlocks; deadlock errors retried with jitter ×3.
- **RLS**: `ENABLE ROW LEVEL SECURITY` on every tenant table; policy `tenant_id = current_setting('app.tenant_id')::uuid`; each request sets `app.tenant_id` on its connection inside the tx (D-002). Platform console uses a BYPASSRLS role only for platform tables — never for tenant data without a `support_grants` row.
- **Numbers**: money/qty NUMERIC as D-003; timestamps `timestamptz` + `business_date` (D-016).

## 5. Offline & sync boundary (summary — full contract in OFFLINE_SYNC.md)

Stable client `op_id` (UUIDv7) + `device_id` + `payload_hash`; server stores dedupe row and applies business validation at sync time (never trust cached prices/totals — recompute server-side); offline issuance of tax documents constrained per OQ-2/OQ-3 with explicit `tax_status` taxonomy.

## 6. Error model

`DomainError` taxonomy: `ValidationError` · `PermissionDenied` · `ConfigurationError` (missing mapping/tax/cost inputs — **blocking, actionable**, INV-17) · `ConflictError` (sync/writes) · `IntegrationError` (ZATCA/Drive/provider, classified retryable/final) · `InvariantViolation` (should never happen → alert). All surfaced to Arabic UI messages with remediation hint; logged with request id.

## 7. Observability & operations

pino JSON logs (level via env) with `request_id`, `tenant_id`, `user_id`; audit via D-018; metrics counters for jobs/sync/postings exposed at health; dead-letter + stale-backup + sync-error alerts to platform console & notifications center.

## 8. Deployment topology

- **Sandbox/dev (here)**: single container, Next.js + in-process worker, local Postgres; `drizzle-kit push` for schema apply.
- **Production (documented target)**: stateless Next.js replicas behind a load balancer (one replica runs the worker — or a locked leader), external managed Postgres (RLS-compatible role), object storage for backups/artifacts; `drizzle-kit migrate` at deploy; rollback = previous build (expand-then-contract migrations, D-023).
- **Secrets**: env vars (D-024); certificates/keys encrypted at rest, never logged.

## 9. Integration contracts (boundaries only — no invented endpoints)

| Integration | Direction | Contract notes |
|-------------|-----------|----------------|
| ZATCA FATOORA | outbound, per tenant cert | onboarding (compliance→production CSID), clearance (standard), reporting (simplified); **implement from current official docs** (D-012); submissions journaled with full status history |
| Google Drive | outbound, platform | OAuth2 refresh-token; resumable upload of encrypted backup; verify by re-reading metadata (D-014) |
| AI providers | outbound | OpenAI-/Anthropic-compatible chat APIs; tool-call loop server-side (D-019) |
| E-payment providers | inbound webhook + redirect | provider-agnostic `electronic_payments` record; settlement status only from webhook/reconciliation (never from tap-to-select) |

## 10. Security architecture

See SECURITY_AND_TENANCY.md (isolation layers, RBAC, session model, encryption, audit, break-glass). Architecture rule: **all authorization decisions happen server-side in services**; route/middleware checks are UX-level only.

## 11. Known trade-offs

- In-process worker couples scaling to web replicas → acceptable v1; extract worker when load demands (queue already DB-backed).
- Shared-schema tenancy needs disciplined RLS + tests → chosen over schema/DB-per-tenant for operability (D-002).
- System image: single time zone per tenant (D-016) — multi-TZ deferred.
