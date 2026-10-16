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
| Retention | conversations purged after N days (default 30) — implemented, see §9; tool-call audit kept per audit policy w/o full payloads |
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

## 8. Implementation status (Phase 9 — built; residuals listed)

**Built and tested** (`tests/unit/ai-assistant.test.ts` 12 + `tests/integration/ai-assistant.test.ts` 14;
see PROGRESS Session 11 for the evidence and the five defects the suites found):

| Piece | Where | Notes |
|---|---|---|
| Provider adapters | `modules/ai/providers/{openai,anthropic,index,types}.ts` | plain `fetch`, injectable `fetchImpl`, 60 s abort, key by env-var **name**, no vendor SDK in the core |
| Availability | `modules/ai/config.ts` | platform flag `ai_assistant` (default ON when no row) → tenant switch (OFF by default) → read-only tenant → provider → model → key; each refusal is an i18n key |
| Read tools (10) | `modules/ai/tools.ts` | `sales_today`, `collections_today`, `price_anomalies` = `sales.invoice.view`; `overdue_receivables` = `reports.view`; `unsettled_reps` = `settlement.review`; `low_stock`, `expiry_soon`, `stock_variance_explain` = `inventory.view`; `income_statement_summary`, `expense_anomalies` = `reports.financial.view`. No tool takes a tenant argument. |
| Action tool | `chat.ts` (`propose_action`) | the only non-read tool; files a ticket, never executes. The intent name is validated against the registry, so an invented intent is a refusal **with an escalation flag**. |
| Tickets | `modules/ai/tickets.ts`, intents in `modules/ai/intents.ts` | `journal_entry_draft` → `accounting.journal.create` (draft only) and `tenant_export` → `reports.export`; 24 h TTL; `proposed → approved → executed | rejected | expired`; approving without the permission changes nothing |
| Guardrails | `modules/ai/guardrails.ts` | 14 EN/AR patterns (flagged, not blocked), delimiters with neutralized breakouts, sanitized/capped answers, capped tool payloads |
| UI | `/assistant`, `/assistant/settings` | chat + tool chips + ticket cards; settings behind `settings.company.manage`, key entered as an env-var name |
| Audit | `ai_conversations`, `ai_messages`, `ai_tool_calls`, `ai_injection_flags`, `ai_approval_tickets` | refusals, escalations, injection hits and ticket ids are all recorded; the transcript keeps tool *names*, not payloads |

**Retention and metering were the two open residuals of Phase 9 and are now built** (§9);
everything else in that list still stands. **Limits in this environment (do not read more into the
green tests than this):** no provider is
called — every turn runs against an injected scripted provider, and the dev tenant's key is a
placeholder; the model's *answers* are therefore never judged for quality here, only the
boundaries around them. Still not implemented: streaming, document/attachment ingestion, per-tenant
provider-terms text, cost/billing computation (metering is counts only, §9). Answers are plain text (no markdown renderer), `MAX_ROUNDS`
= 3 and `MAX_TOOL_CALLS_PER_TURN` = 6 are hard caps, and asking is open to any tenant user —
the tool permissions and the ticket permission are the boundaries, not a separate `ai.use` code.

## 9. Retention & metering (Phase 9 residuals — built)

| Piece | Where | Behavior |
|---|---|---|
| Retention sweep | `modules/ai/retention.ts` | Age key `coalesce(last_message_at, created_at) < now − retentionDays` (default 30). Deletes **conversations only**; messages cascade, `ai_tool_calls`/`ai_injection_flags` survive with a NULL reference, **`ai_approval_tickets` are never touched**. Each sweep audits `ai.retention.purged` (counts, window, cutoff) in the tenant's own chain. A read-only (suspended/deactivated) tenant is reported as `skippedReason: errors.tenantReadOnly` **before** any work — a purge that did not run must never print as "0 expired". |
| Scheduling | `modules/jobs/worker.ts` | Runs inside the existing `platform-maintenance` queue (daily 01:15) before the backup-freshness check; logs `aiRetention {swept, conversations, skipped}`. Driven from `selectDistinct(tenant_id) from ai_conversations`, so an unused deployment visits nothing. |
| On demand | `npm run ai:retention [-- --dry-run]` (`scripts/ai-retention.mts`) | `--dry-run` reports what *would* be removed (threads/messages per tenant, retained ticket count) and removes nothing. |
| Metering | `modules/ai/usage.ts` + one call per turn in `chat.ts` | Six additive counters in `usage_metrics`: `ai_turns`, `ai_tokens_in`, `ai_tokens_out`, `ai_tool_calls`, `ai_refusals`, `ai_injection_flags`, per tenant per month. **Counts only** — no question, answer or amount is stored, and metering failures are caught and logged, never allowed to fail an answer. |
| Console view | `platform/(console)/tenants/[id]` | "AI assistant usage (counts only)" card for the current month. No tenant content, ever (PLATFORM_ADMIN §3). |

**Why the upsert is additive:** the platform helper `recordUsage` *assigns* a snapshot
(`value = n`), which is correct for plan/quota metrics and wrong for counters — a second turn in
the same month would have replaced the month's totals with one turn's numbers. Token/call
counters therefore use `value + n::numeric`.
