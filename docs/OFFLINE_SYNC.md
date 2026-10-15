# Offline-First Sync — Representative PWA

Genuine offline operation is a core business requirement (vans lose connectivity). This
document is the protocol contract; business limits are in §6; legal limits for tax
docs in INVOICING_AND_ZATCA §7.

## 1. Platform capabilities & limits (documented, not worked around)

| Capability | Android Chrome (target) | iOS Safari (disclosed limits) |
|------------|------------------------|-------------------------------|
| App shell caching (Service Worker) | yes | yes |
| IndexedDB persistence | yes (best-effort durability; `navigator.storage.persist()` requested) | yes w/ eviction pressure risk → warning banner if storage not persistent |
| Background sync | yes | **no reliable background sync** → foreground auto-sync + pull-to-sync |
| Push notifications | yes | limited (badges/webpush restrictions vary by version) → in-app notification center primary |
| Install (PWA) | yes | yes ("Add to Home Screen") |

## 2. Local data model (Dexie/IndexedDB)

| Table | Contents | Notes |
|-------|----------|-------|
| `outbox` | unsynced ops (§4 envelope) | durable; survives restart/reboot |
| `cache_products`, `cache_customers`, `cache_prices`, `cache_stock` | read replicas scoped to rep permissions + assigned customers | stamped with pulled cursor + TTL |
| `local_docs` | locally created invoices/receipts/returns/transfers-acceptance incl. full status | op_id == document client id (UUIDv7) |
| `sync_meta` | high-watermark cursor per scope, device id, backoff state, last errors | |
| `conflicts` | server-rejected/conflicted ops w/ resolution state | drives sync dashboard |

Local writes are atomic per op (Dexie transaction): doc insert + outbox insert +
local stock decrement together. Cached stock numbers are labeled "متاح تقريبي (آخر مزامنة: HH:mm)".

## 3. Operation envelope (every mutating action)

```
op_id        UUIDv7 (client-generated, stable across retries)
device_id    registered device
tenant_id + user_id (asserted; server re-binds to session/cert)
op_type      invoice.create | receipt.create | return.create | transfer.accept |
             expense.create | settlement.request | customer.update | …
entity_id    = op_id for creates
payload      canonical JSON (zod schema version embedded: payload_v)
payload_hash sha256(canonical payload)
created_at   client UTC instant + device clock skew note
depends_on   optional op_id ordering (e.g., return depends on its invoice ack)
```

Retrying or re-queuing **reuses the same op_id + payload**; editing before sync creates
a **new op** (supersede link) unless still `pending` and never sent.

## 4. Protocol

```mermaid
sequenceDiagram
    participant R as Rep PWA (outbox)
    participant A as /api/sync (server)
    participant S as Services (posting/stock/tax)
    R->>A: PUSH batch [ops by created_at, depends_on order] + device creds
    A->>A: per op: idempotency lookup (op_id, device)
    alt known op_id + same payload_hash
        A-->>R: ACK + original server result (no re-apply)
    else known op_id + different hash
        A-->>R: REJECT tamper (audit security event)
    else new op
        A->>S: validate+apply in tx (recompute prices/tax; re-check permissions, stock, credit; offline-limit checks)
        S-->>A: result (doc refs, official numbers, statuses)
        A-->>R: ACK w/ result | REJECT w/ Arabic reason | CONFLICT w/ server state
    end
    R->>A: PULL {scope cursors}
    A-->>R: deltas since cursor (products, prices, customers, ledger-derived custody, statuses), new cursors
```

- **Batch semantics**: per-op results; one failing op never blocks others unless `depends_on` chains them.
- **Server dedupe**: `idempotency_keys(op_id, device_id) UNIQUE` storing payload_hash + result ref (INV-02/05).
- **Pull**: high-watermark = `(updated_at, id)` tuple per scope; deletes as tombstones.
- **Backoff**: retry delay = `min(30s × 2^n + jitter(0–30%), 15 min)`; permanent failures (validation/permission/tamper) are **not retried** — they become `rejected`/`conflict` for the dashboard.

## 5. Operation states (visible per document)

`pending` → `syncing` → `synced` (server accepted; carries final statuses incl. tax) ·
`rejected` (validation/permission/stock/credit — fix locally and re-issue as new op) ·
`conflict` (server state diverged — resolve per §7). Docs also display their business tax
status (`issued_pending_reporting` etc. — never conflated with sync status).

## 6. Offline business limits (defaults provisional — OQ-9)

| Limit | Default | On breach |
|-------|---------|-----------|
| Open offline invoices per device | 50 | block new invoice; force sync |
| Offline invoice max value | SAR 5,000 | block w/ message |
| Offline credit sale | only if cached customer headroom ≥ 120% of invoice (limit − exposure) else cash-only | reject at sync if actually over → `rejected` w/ reason + notify accountant |
| Cached stock | decrement locally; negative local allowed to −0 flag (warning), server check authoritative at sync | sync oversale → `conflict: stock_shortfall` routed to accountant (invoice stays `pending_resolution`, never auto-posts wrong stock) |
| Max offline age of prices/stock cache | 48 h warning, 7 d hard stop for posting new credit invoices (cash allowed w/ warning) | banner + block per rule |
| Tax-sensitive docs offline | per INVOICING_AND_ZATCA §7 (simplified may be issued w/ reporting deadline; standard blocked) | enforced in doc type gating |

## 7. Conflict resolution (business rules — not "last write wins")

| Entity | Rule |
|--------|------|
| Invoice/receipt/return | client-created docs never collide (op_id namespaced); server may **reject** (credit/stock/permission) → user fixes & re-issues as new op referencing the rejected one |
| Customer profile edits | server version check; mismatch → `conflict`, UI shows both versions, rep/accountant picks field-level merge; audit both |
| Transfers (accept) | server state wins on quantities already received; accepting an already-closed transfer → reject with current state |
| Cached catalogs/prices/stock | server authoritative |
| Settlement requests | unique open settlement per rep/day; duplicates coalesce to the same request id |

## 8. Security controls at the edge

Registered devices only (revocation immediate); per-op payload immutability after accept
(hash mismatch = security event); server-side recomputation of prices/totals/tax/limits
(client payloads are hints); local DB minimization (SECURITY_AND_TENANCY §5); idle
session expiry requires re-auth to *sync* while allowing read of already-cached data
(configurable); remote-wipe signal on revocation/theft report (best-effort).

## 9. Sync dashboard (rep UI)

Counts by state, per-op error with fix action, "retry all failed", storage persistence
warning, last successful sync, conflict list w/ resolver, version + device id (for
support), manual pull. Accountant side: per-rep sync health (pending ops age, rejected
ops, devices last seen) feeding settlement review (§5.1 "unresolved").

## 10. Recovery scenarios (acceptance-tested)

Restart/reboot with pending ops → outbox intact, auto-resume. Update mid-queue (app
version change) → outbox schema versioned; migrations run before flush. Duplicate push
after timeout → ACK-idempotent. Clock skew → server stamps authoritative times; business
date from server. Credential expiry mid-batch → 401 → re-auth → resend identical batch.

## 11. Observability

Per-device sync metrics (ops accepted/rejected/conflicts, lag), server dashboard, alerts
on rejection spikes / stuck outboxes > threshold / device offline > configured days.
