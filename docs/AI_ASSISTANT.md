# AI Assistant (optional, disabled by default)

A tenant-level assistant that answers authorized business questions and prepares (never
unilaterally executes) actions. Multi-provider, permission-aware, fully audited.

## 1. Providers & configuration (D-019)

- Adapters for **OpenAI-compatible** (base_url + key; e.g., OpenAI, Azure, OpenRouter,
  self-hosted vLLM/Ollama) and **Anthropic-compatible** APIs. Provider code lives in
  `modules/ai/providers/*`; core accounting never depends on it.
- Per-tenant config: enabled flag (default OFF), provider, model, key (env-referenced
  or encrypted store), data-sharing scope (see §5), conversation retention days.
- Keys never in source control; never sent to the browser; all calls are server-side.

## 2. Architecture

```mermaid
flowchart LR
    UI[Chat UI (ERP)] --> SRV[ai/chat server action]
    SRV --> CTX[Context builder: user, roles, tenant, locale]
    SRV --> REG[Tool registry (permission-gated)]
    REG -->|read tools| QRY[Read services / report queries]
    SRV --> LLM[Provider adapter]
    LLM -->|tool_call| REG
    REG -->|mutating intent| TICK[Approval ticket → human executes in normal UI/services]
    SRV --> AUD[(ai_conversations + ai_tool_calls audit)]
```

- The model never receives DB credentials, secrets, other tenants' data, or raw SQL
  ability. All data access is through the tool registry.
- Retrieved documents/tool outputs are **untrusted content** (prompt-injection risk):
  wrapped in delimiters, excluded from instruction parsing, and the system prompt forbids
  treating tool text as instructions.
- Arabic-first: system prompt + answer language follows user's UI locale.

## 3. Tool registry (v1 — read-only analytics)

Each tool: `name`, zod input schema, required permission, implementation (reuses Phase 7
report services — never re-implements figures), output limits (row caps, field allowlist).

| Tool | Permission | Data |
|------|-----------|------|
| `sales_today` | sales.view | totals & collections for business_date today vs yesterday |
| `collections_today` | sales.view | receipts by method e-payments pending count |
| `overdue_receivables` | ar.view | top overdue customers (limit 20) w/ amounts & days |
| `unsettled_reps` | settlement.view | reps with open settlements + age |
| `low_stock` / `expiry_soon` | inventory.view | threshold lists (limit 50) |
| `income_statement_summary` | reports.financial | month-to-date summary lines |
| `price_anomalies` | sales.approve | overrides/discount outliers in range |
| `expense_anomalies` | expenses.view | unusual expense spikes vs 3-month baseline |
| `stock_variance_explain` | inventory.view | ledger-derived decomposition of a count difference (lots, transfers, adjustments) |

## 4. Actions & approvals

- v1: the assistant may **prepare** (draft journal proposal, draft message, list of
  suggested allocations) — saved as drafts visible to the user, executed only by a human
  clicking through the normal UI (same permissions, same services, full audit).
- Never model-decided: posting, deleting, reversing, tax config, payroll, settlement
  finalization, regulated document issuance (D-019 hard rule; enforced by not exposing
  such tools at all).
- Approval tickets (`ai_approval_tickets`) capture intent + payload + expiry; execution
  via service layer only; ticket state machine: proposed → approved | rejected → executed.

## 5. Privacy & data minimization

| Choice | Behavior |
|--------|----------|
| Scope "metrics only" (default) | aggregates/numbers + masked names (C-1042 style) where names aren't needed |
| Scope "names allowed" | customer/product names included when the question needs them |
| Retention | conversations purged after N days (default 30); tool-call audit kept per audit policy w/o full payloads |
| Region/provider | per-tenant documented choice; no training-opt-in APIs assumed — provider terms summarized in config UI |
| Hard exclusions | passwords, secrets, other tenants, raw ledger exports, free-text attachments |

## 6. Guardrails

- System prompt: tenant-scoped duties only; refuse out-of-scope; never fabricate figures (answer "لا تتوفر بيانات" instead); cite tool names used; respond in user's locale.
- Input: length caps; injection-pattern logging (not blocking—flagged); file/doc ingestion treated as data-only.
- Output: capped, no HTML injection into UI (rendered as sanitized markdown), monetary figures formatted per tenant.
- Kill switch: per-tenant flag + platform global flag; outage = degrade silently to "المساعد غير متاح".

## 7. Audit & test requirements

Log: conversation id, user, tools called + zod-validated args, token counts, latency,
provider/model, ticket ids. Tests (Phase 9): tool permission matrix (rep can't call
income_statement_summary; cross-tenant params ignored/overridden server-side), injection
can't escalate (seeded malicious text in customer notes → no tool abuse), no-SRB: model
cannot call unregistered tools, approval flow executes via services with audit.
