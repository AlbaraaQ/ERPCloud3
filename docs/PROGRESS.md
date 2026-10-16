# Progress Log

**Read this first** when resuming work (see README → session protocol). Entries are
append-only per session, **newest first**; keep them factual — commands and results
exactly as observed.

## Session 12 — 2026-10-16 · Phase 9 residuals closed (retention purge job + token metering) → Phase 10 started

### Status: both Phase 9 residuals implemented ✅ · 3 new integration tests · gate green (`npm test` 20 files / 173 passed / 8 skipped / 0 failed · `tsc` clean) · Phase 10 (UX completion, hardening & release readiness) next

> **Honesty notes.** (1) No provider is called here either — the metering test drives the
> assistant through the injected scripted provider, and the dev tenant's `ASSISTANT_API_KEY`
> remains a placeholder. The counters below are therefore *real* counters over *scripted*
> turns: they prove that usage is recorded once per turn, per tenant, per month, and that it is
> **counts only** — they do not claim live token billing. (2) The retention sweep is exercised
> against the dev database with an aged thread created by the test itself; the numbers below
> come from that run, not from a production corpus. (3) `npm run ai:retention -- --dry-run` is
> read-only: it reports what a sweep *would* remove and removes nothing.

### Work completed

- **`modules/ai/usage.ts` — counts-only metering.** `AI_METRICS = ai_turns | ai_tokens_in |
  ai_tokens_out | ai_tool_calls | ai_refusals | ai_injection_flags`; the upsert is **additive**
  (`value + n::numeric`), so a second turn in the same month no longer rewrites a whole period
  (the platform helper `recordUsage` *assigns* a snapshot — the right thing for plan/quota
  metrics, the wrong thing for counters). `recordAiUsage(tenantId, sample)` stores **numbers
  only**: no question, no answer, no amounts. It is wrapped in `try/catch` + `warn`: a metering
  failure must never turn into a failed answer.
- **`chat.ts` records exactly one sample per completed turn** (turns/tokens/tool calls/refusals/
  injection flags), taken from the turn's own tallies.
- **`modules/ai/retention.ts` — tenant-safe purge.** Age key is
  `coalesce(last_message_at, created_at) < now - retentionDays`; messages cascade with their
  thread while `ai_tool_calls`, `ai_injection_flags` (reference set to NULL) and
  **`ai_approval_tickets` (untouched)** survive — a ticket records a human decision that may
  have produced an accounting document, and retention of chat text is not a licence to forget
  it. Each tenant sweep writes `ai.retention.purged` with the counts, the window and the cutoff
  in the *tenant's own* chain. A non-writable tenant is detected **before** the sweep and
  reported as `skippedReason: errors.tenantReadOnly`, never as an honest-looking "0 expired".
  `purgeExpiredAiConversations()` drives the sweep from `selectDistinct(tenant_id) from
  ai_conversations`, so a deployment where nobody asks anything visits nothing.
- **Scheduling:** the sweep runs inside the existing `platform-maintenance` queue (daily 01:15),
  before `checkBackupFreshness`, and logs `aiRetention {swept, conversations, skipped}`.
  On demand: `npm run ai:retention [-- --dry-run]` (`scripts/ai-retention.mts`).
- **Platform console:** the tenant detail page gained an **AI usage** card (turns, tokens in/out,
  tool calls, refusals, injection attempts) fed by `aiUsageSnapshot(tenantId, month)` with the
  explicit note that it shows aggregated counts for the current month only.
- **Assistant screen (Phase 10 accessibility pass, started):** the transcript is a `role="log"`
  with `aria-live="polite"` / `aria-busy`, the unavailable and notice banners carry
  `role="status"` (errors `role="alert"`), the composer has an `aria-label`, and the
  scope/retention badge now shows localized words ("أرقام مجمّعة وأسماء مقنّعة · 30 يوم") with
  the full description in `title` instead of raw identifiers (`metrics_only`) in the UI.

### Commands executed → results

| Command | Result |
|---------|--------|
| `npm run ai:retention -- --dry-run` | tenant `01a141ee-5e7e-749c-b3e7-f52d51781af3` · retentionDays **30** · cutoff `2026-09-16T00:08:59.740Z` · 0 conversations / 0 messages · "approval tickets retained: 1" |
| `npm run typecheck` | ✓ exit 0 (after the i18n keys landed; see defect 6) |
| `set -a && . ./.env && set +a && npx vitest run tests/integration/ai-assistant.test.ts` | ✓ **17 tests passed** (14 + 3 new: metering, purge, read-only skip) |
| `set -a && . ./.env && set +a && npm test` | ✓ **20 files / 173 passed / 8 skipped / 0 failed** (was 170 passed) |
| live curl `/assistant` (tenant session, dev server :3000) | 200 · `role="log"`, `aria-live="polite"`, `aria-busy="false"`, badge "أرقام مجمّعة وأسماء مقنّعة · 30 يوم" |
| live curl `/platform/tenants/01a141ee-…` (platform session) | 200 · AI-usage card renders: heading «استخدام المساعد الذكي (أعداد فقط)», rows عدد الأسئلة / توكنات الإدخال / محاولات توجيه مشبوهة + the counts-only note |

### Defects found and fixed while doing this (with the lasting rules they produced)

| # | Defect | Effect if shipped | Rule |
|---|--------|-------------------|------|
| 6 | the i18n patch script asserted on the *wrong* anchor (`"الحدود والاستخدام"` instead of the real `quotas: "الحصص والاستخدام"`) | the seven platform keys were never written while the page already used them → `tsc` red with 5 × `TS2339` | grep the anchor before scripting a dictionary edit; a dictionary patch that fails must fail **loudly** — it did, and the tree was never committed red |
| 7 | the new screen props were declared in **both** the label interface and the component's `Props` | duplicate (harmless but misleading) interface members | one home per label: the label bag owns the wording, the component owns the data |
| 8 | (design) a read-only tenant would have been reported as "0 conversations expired" | a purge that did not run would have looked like a purge that found nothing | *skipped* and *empty* are different facts and must print differently |

### Residuals (updated)

1. **No live provider exchange anywhere** — unchanged (scripted provider; placeholder key).
2. No streaming answers, no document/attachment ingestion, no per-tenant provider-terms text.
3. Asking is still open to any tenant user; the boundaries remain the tool permissions and the
   intent permission (a dedicated `ai.use` code was deliberately not introduced).
4. Metering is **counts only** — no cost/billing computation, by design (a price per token would
   be a commercial assumption this build does not own).
5. Retention applies to `ai_conversations` only, by design (audit tables, tickets and the
   platform chain are out of its scope and are proven to survive).

### Phase 10 started (same session, after the commit above)

**Added**

- `tests/unit/ui-guards.test.ts` — 11 structural assertions that fail the suite if the app's
  security *shape* changes: every page is behind a session/platform guard (its own or an enclosing
  layout's), every console page resolves a platform context, the console has exactly one layout
  door, every permission named at a guard site exists in the right catalogue, tenant navigation
  uses real tenant codes only, the ops role holds **no** destructive code, an unknown role gets an
  empty set, and only four named non-platform files may import platform services. Verified to have
  teeth by mutation: renaming a nav code and adding an unguarded top-level page each failed the
  suite, and both were reverted.
- `scripts/acceptance-sweep.mts` (+ `npm run acceptance:sweep`) — the HTTP acceptance sweep: mints
  a tenant and a platform session, walks 30 screens (3 public / 18 tenant / 9 console) asserting
  200 + RTL shell + no framework error document, proves the two session namespaces cannot open each
  other's screens, and runs an optional warm soak. **Passed 39/39**, soak 20 requests / 0 failures
  (mean 315 ms, p50 195 ms, p95 622 ms).
- `docs/OPERATIONS_GUIDE.md` — the bilingual deliverable the user asked for (Arabic): run and use
  the system, module by module, with the platform console, operations, troubleshooting and the
  honest limits of this build.
- `docs/RUNBOOK.md` — deploy order, rollback (app vs data), routine cadences, alert semantics and
  six incident playbooks.
- `docs/RELEASE_READINESS.md` — the Phase 10 verdict with the evidence table, item-by-item status
  and the ranked blockers.

**Re-drilled (fresh evidence, not a re-quote)**

| Command | Result |
|---------|--------|
| `npm run typecheck` | ✓ 0 errors |
| `set -a && . ./.env && set +a && npm test` | ✓ **21 files / 184 passed / 8 skipped / 0 failed** |
| `npm run build` | ✓ compiled successfully (13.2 s), all routes emitted |
| `npm run acceptance:sweep -- --soak=20` | ✓ **ACCEPTANCE SWEEP PASSED — 39/39 checks** |
| `npm run backup:run` | ✓ 81 tables / 6737 rows · artifact sha `cd07baed…` · remote `local-contract` verified |
| `npm run backup:verify` | ✓ `verified` — 6/6 checks (incl. 149 FKs inside the snapshot) |
| `npm run backup:drill` | ✓ `passed` — 7/7 invariants · `restore_drill_mva88f67` · RTO ≈ 1.6 s |
| live `/assistant` + `/assistant/settings` (minted session) | 200, RTL shell, all Arabic markers |
| live question with the placeholder key | the honest answer `errors.aiUnavailable` («المساعد غير متاح حالياً…») and **no fabricated figure**; the failed turn is still recorded and metered |

**Verdict recorded:** **not production-ready**, for reasons that are environmental/processual
(migrations, off-site backup transport, a real ZATCA credential cycle, open OQ-2/3/4, browser-driven
E2E and AA coverage, deployment automation) rather than unfinished product features — see
`RELEASE_READINESS.md` §5.

### Continuation — the sandbox rebooted; the environment was rebuilt from the template

**What happened.** The workspace snapshot does not carry `node_modules/`, the embedded database
directory `.pglite/`, or the gitignored `.env` (never a credential file in a snapshot). After the
restart the tree was source-complete and unrunnable, which is exactly the state a new operator
starts from.

**Defect found while recovering (the user's report, and it was real):** `OPERATIONS_GUIDE.md` told
the reader to run `cp .env.example .env`, and **there was no `.env.example`**. The first instruction
of the guide could not be executed. Fixed by writing the template (grouped, Arabic+English, no
secret values, `.env` left untracked and the template explicitly un-ignored) and by locking it with
`tests/unit/env-example.test.ts`:

| Assertion | Why |
|---|---|
| every `process.env.*` read by `src/` or `scripts/` is declared (`FRAMEWORK_VARS` allow-lists only `NODE_ENV`/`NEXT_RUNTIME`/`USER`) | the template can never silently drift behind the code |
| every variable in the guide's §1.5 table is declared | documentation promises a settable variable; the promise is checkable |
| if the guide says `cp .env.example .env`, the file exists and is non-trivial | the exact defect above cannot come back |
| secrets are present but **empty** (`HISAB_ENCRYPTION_KEY`, seed passwords, assistant key, Drive secret/token) | a template must not ship a working credential |
| `HISAB_ALLOW_LIVE_RESTORE` is absent by default | live restore is an announced-window operation |
| `.gitignore` contains `!.env.example` | the template survives the `.env` ignore rule |

Both directions were mutation-tested: deleting `PG_POOL_MAX` failed the completeness assertions, and
filling `HISAB_ENCRYPTION_KEY` failed the safety assertions; the file was restored and the suite is
green again.

**Second surprise, same reboot: the checkout was re-cloned at the branch's *base* commit.** A fresh
clone had `HEAD = a52a1f0` (the branch point) with an index to match, while the working tree held the
real source, so `git status` looked like a project mid-rewrite (dozens of "modified" and "untracked"
files that were in fact already committed). Nothing was lost: the branch tip was intact on the
remote. Recovery was `git fetch origin arena/60f797f0-erpcloud3` → `git reset --mixed <tip>`, after
which the tree showed exactly this session's work and nothing else. **Lesson recorded:** after any
sandbox restart, verify `git log -1` against the remote **before** staging anything — a stale HEAD
plus `git add -A` is how a session accidentally deletes a phase.

**Recovery executed, using the guide's own instructions (no ad-hoc path):**

| Step | Command | Result |
|------|---------|--------|
| dependencies | `npm install --no-audit --no-fund` | 480 packages |
| environment | `cp .env.example .env` + filled 4 lines (key generated with the command printed in the template) | 9 active variables |
| engine | `node scripts/dev-postgres.mjs --dir .pglite` | PostgreSQL 18.6 (PGlite) on 127.0.0.1:5432 |
| schema + RLS + seed | `node scripts/db-reset.mjs` | 52 permission codes · platform owner · two demo tenants (tenant A id `01a1422b-a19c-7f39-8261-08cf41f0253f`) |
| types | `npm run typecheck` | ✓ 0 errors |
| suite | `set -a && . ./.env && set +a && npm test` | ✓ **22 files / 192 passed / 8 skipped / 0 failed** (2 test files were added afterwards — see the re-verification table below) |
| acceptance | `npm run acceptance:sweep -- --soak=20` | ✓ **39/39 checks** · soak mean 192 ms / p50 186 ms / p95 406 ms |
| data safety | `npm run backup:run` · `verify` · `drill` | artifact sha `fbfbb66cd0da63d7…` · 81 tables / 1518 rows · verify 6/6 · drill 7/7 · RTO ≈ 1.7 s |

> The backup run/verify/drill from the previous session referred to tenant ids `01a141ee-…`; the
> rebuilt database has new ids. Both runs are real, and neither is presented as a re-quote of the
> other. `docs/RELEASE_READINESS.md` §8 records this rebuild as the end-to-end proof of the
> onboarding path.

### Continuation — “verify and fix everything”: the onboarding path, walked end to end

The user reported two failures in the preview (`Invalid Server Actions request.` on login, and no
`.env.example` for the guide's first command) and asked for a full sweep: **تحقّق وأصلح كل الأخطا**.
Both were real, and following the path as a *new operator* found three more. All five are fixed, and
each one now has an executable guard rather than a note.

| # | What a first-time operator hit | Root cause | Fix / guard |
|---|-------------------------------|-----------|-------------|
| 1 | login 500 `Invalid Server Actions request.` behind the preview proxy (localhost fine) | the proxy makes `Origin` (public host) differ from `host` / `x-forwarded-host`; Next refuses Server Actions unless the public origin is allow-listed | `experimental.serverActions.allowedOrigins` in `next.config.ts`, overridable via `HISAB_ALLOWED_ORIGINS`; `npm run login:probe` posts with React's own client encoding from the preview origin and asserts a *foreign* origin is still refused |
| 2 | `cp .env.example .env` — no such file | the template had never been committed | `.env.example` (tracked, secret-free, `!.env.example` in `.gitignore`) + `tests/unit/env-example.test.ts` |
| 3 | every demo login failed even though the seed printed the right password | `SEED_DEMO_PASSWORD=Hisab#2026` was **truncated to `Hisab`** by the dotenv parser, and `db:seed` left existing users untouched | passwords quoted in `.env`/template; `scripts/env-check.mts` refuses a bare `#`; `db:seed` re-applies the environment password (demo users **and** the platform owner) and says so; `tests/unit/setup-workflow.test.ts` runs the real scripts and asserts the value survives parsing |
| 4 | the console was unenterable on a fresh install | the login action returns `redirectTo: "/platform/login/enroll"` for an unenrolled operator, and the form **ignored that field** | `src/app/platform/login/login-form.tsx` navigates on `redirectTo` (plus a plain link); the probe completes login → enrollment → real RFC 6238 code → `/platform` 200 |
| 5 | “it works on my machine” only — no proof the login path works *in the delivered conditions* | nothing exercised the proxy→Server-Action hop | `npm run login:probe` (15 checks) is now part of the pre-publish gate, documented in `RUNBOOK.md` and the guide |

**The workflow the user asked for, kept by name and order:**

```bash
npm run env:setup     # .env from the template; key generated; passwords written quoted
npm run env:check     # early, bilingual refusal of an empty key or a truncated secret
npm run db:migrate    # schema + src/db/rls.sql (227 policies) — non-destructive, safe to repeat
npm run db:seed       # catalog, platform owner, two demo tenants — idempotent
npm run login:probe   # both login surfaces, from a proxied origin — 15/15
```

`db:migrate` is deliberately a *migration* and not a reset: it reports `✓ schema current — 227
policies active` and never drops data (`db:reset` stays the destructive, dev-only path). The probe's
console section runs on a **temporary probe account**, never the real owner — enrolling (or
throttling) a real operator while testing would be a worse bug than the one being tested. The probe
account is left `disabled`, because deleting it is refused by design: `platform_audit_log` is
append-only with a foreign key to `platform_users` (SQLSTATE 23001), so an operator who ever signed
in cannot be erased. That refusal is honoured, not worked around.

**Re-verified after all five fixes** (fresh run, same workspace):

| Gate | Result |
|------|--------|
| `npm run typecheck` | ✓ 0 errors |
| `set -a && . ./.env && set +a && npm test` | ✓ **23 files / 202 passed / 8 skipped / 0 failed** (24 files / 259 after the accessibility work below) |
| `npm run build` | ✓ compiled successfully (14.6 s), all routes emitted |
| `npm run login:probe` | ✓ **LOGIN PROBE PASSED — 15/15** |
| `npm run acceptance:sweep -- --soak=10` | ✓ **ACCEPTANCE SWEEP PASSED — 39/39** (soak mean 157 ms · p50 150 ms · p95 251 ms) |

> One sweep run in this session reported 38/39 with `soak: 20 requests, 20 failures` and 1 ms
> “latencies”: the dev server had been reaped mid-run. The sweep now prints that diagnosis, including
> the first failing route, instead of twenty identical numbers — a measurement that cannot fail
> loudly is not a measurement.

### Continuation — the screen audit, done as an audit (77 violations, 0 remaining)

Phase 10's remaining item was "screen-by-screen RTL/AA/colour-independence audit". An audit that is
a promise is not an audit, so it was built twice over:

- **`tests/unit/a11y-tokens.test.ts`** (57 assertions) reads `src/app/globals.css` and computes WCAG
  contrast for every foreground/background pair the screens actually use, in **both** themes — text
  ≥ 4.5:1, focus ring and form-control outline ≥ 3:1, plus a hue check that keeps "warning" from
  becoming "failure" and keeps a meaning the same colour family in dark mode. Mutation-tested:
  restoring the old ring value fails the suite at 2.49:1.
- **`npm run a11y:audit`** walks all **28** reachable screens with a real session, parses each
  document, and asks what a screen reader or a keyboard user would ask: language and direction, one
  h1, no skipped heading level, a name for every control and every button/link, natural tab order,
  nothing focusable hidden behind `aria-hidden`, a header cell in every table, unique ids, and no
  state carried by colour alone. It prints the rule, the screen and the element, and exits non-zero.

**First run: 77 violations across 9 screens.** All of them were real:

| What was wrong | Why it mattered | Fix |
|---|---|---|
| light focus ring 2.49:1 on a white card | below the 3:1 of WCAG 1.4.11 — a keyboard user can lose the caret | `--ring` `#14b8a6` → `#0d9488` (3.36–3.74:1) |
| `text-warning` on `bg-warning-soft` = 4.26:1 | every "expiring soon" chip, at 11 px | `--warning` `#b45309` → `#92400e` (6.02:1) |
| a form control's outline 1.23:1 on white | the field is filled like the card behind it, so the outline **is** the control | new `--input` token, light `#7d8b99` / dark `#5a6b7f` (≥3.0 on every surface) |
| the login hero's 12 px tagline: white/70 on teal = 3.54:1 | below 4.5:1 | white/90 (4.75:1) |
| ~58 controls with a placeholder but no name | announced as "edit text" — the ledger grid, purchase lines, and every BOM/order/scrap form | translated `aria-label`s that carry the row number ("مدين ٣", "الكمية ٢") |
| 2 icon-only buttons (delete line) | announced as "button" | `aria-label` + `title` from the dictionary (new `common.removeLine`) |
| 3 tables without a header cell | a value read aloud has no column | `<th scope="row">` for the account-mapping rows, a real `<thead>` for the console's backup history |
| /pos and an empty rep catalogue had no h1; 3 screens skipped a heading level | a screen reader's heading list is the table of contents | `sr-only` h1, a heading on the empty state, h3/h4 promoted where they were top-level |
| the console's `Message` was a plain `<p>` | it is the single component every console form reports success or failure through, and nothing was announced | `role="alert"` (danger/warning) / `role="status"` (success) |

**Last run: `A11Y AUDIT PASSED — 28 screens, no violations`.** The pre-fix run is its own control:
the same rules reported 77 problems on the same screens.

Two things the audit deliberately does **not** claim: a real screen-reader pass in Arabic, and a
keyboard-only sweep of POS and the assistant. Both need a person and a browser; both are recorded as
outstanding in `RELEASE_READINESS.md` §5 rather than implied to be done.

### Exact next step (Phase 10, continued)

1. Screen-by-screen RTL/bilingual + AA (contrast, focus order, keyboard) + colour-independence
   audit; add browser-driven E2E once a runner is available.
2. Close the ranked blockers in `RELEASE_READINESS.md` §5 for a production go-live.

---

## Session 11 — 2026-10-16 · Phase 9 (AI assistant) implemented — chat, permission-gated tools, approval tickets, audit

### Status: Phase 9 implemented ✅ · 5 defects found and fixed · 6 documented residuals · Phase 10 (UX completion & release readiness) next

> **Honesty notes.** (1) **No provider is called in this environment.** Every test drives the
> assistant with an injected scripted provider; the dev tenant is switched on with a
> *placeholder* env var, so a real message from the preview ends with the honest
> "المساعد غير متاح" answer rather than a fabricated one. Nothing here claims a live
> OpenAI/Anthropic exchange. (2) The assistant has **no write path**: the single action tool
> files an approval ticket, and execution happens in `decideTicket` under the *approver's*
> identity and permission, through the normal services. (3) Figures come from the Phase 7
> report services — the assistant never re-implements a number, and `price_anomalies` refuses
> (`tool_unavailable`) because R-24 is not implemented in this build.

### Work completed

- **Schema (applied to the dev DB with `drizzle-kit push`):** `ai_tenant_config`
  (enabled OFF by default, provider/model/`baseUrl`/`secretRef`/dataScope/retentionDays),
  `ai_conversations`, `ai_messages` (answer text + tool *name*, never tool payloads),
  `ai_tool_calls` (validated args, ok, denial reason, rows, escalation flag, latency),
  `ai_injection_flags` (source: `user_input|tool_output`), `ai_approval_tickets`
  (intent/payload/summary/required permission/expiry/decision/execution) + enums
  `ai_data_scope|ai_role|ai_ticket_status`.
- **Providers** (`modules/ai/providers/*`): OpenAI-compatible (`/chat/completions`) and
  Anthropic-compatible (`/v1/messages`) adapters over plain `fetch` (no vendor SDK), key read
  from `process.env[secretRef]` **by name**, 60 s abort timeout, injectable `fetchImpl`.
  Round-trip fidelity fix: assistant turns now carry their `tool_calls`/`tool_use` blocks, so
  the tool results that follow are a legal conversation for both APIs.
- **Availability** (`aiAvailability`, `config.ts`): platform flag (`ai_assistant`, default ON
  when no row) → tenant switch (default OFF) → **read-only tenant** → supported provider →
  model → key present. Every refusal is an i18n key, never a stack trace and never an empty
  answer. Availability includes the read-only check because the assistant has no mode that
  answers without writing its audit rows.
- **Tool registry** (`tools.ts`, 10 read tools) — permission-gated, zod-validated, tenant id
  is never an argument, row caps, masked labels under `metrics_only`, honest `unavailable`
  for R-24. Mapping: `sales_today`/`collections_today`/`price_anomalies` → `sales.invoice.view`;
  `overdue_receivables` → `reports.view`; `unsettled_reps` → `settlement.review`;
  `low_stock`/`expiry_soon`/`stock_variance_explain` → `inventory.view`;
  `income_statement_summary`/`expense_anomalies` → `reports.financial.view`.
- **Chat orchestration** (`chat.ts`): max 3 provider rounds and 6 tool calls per turn; every
  round, refusal, injection hit and proposal is recorded; conversation ids that are not the
  caller's own are ignored (and logged), never resolved into someone else's thread.
- **Intents & tickets** (`intents.ts`, `tickets.ts`): `journal_entry_draft`
  (`accounting.journal.create` → `createDraftManual`, stays **draft**) and `tenant_export`
  (`reports.export` → `buildTenantExport`). State machine `proposed → approved → executed |
  rejected | expired`, 24 h TTL, payload re-validated at execution, both the decision and the
  execution written to the tenant audit chain, `errors.permissionDenied` (and *nothing*
  changed) for an approver without the intent's permission.
- **Guardrails** (`guardrails.ts`): 14 EN+AR injection patterns (flag, never silently block),
  `wrapUntrusted` delimiters with **neutralized breakout sequences**, `buildSystemPrompt`
  (data-only rule, no-mutation rule, cite-tools rule, masking rule), `sanitizeAnswer`
  (script/handler stripping, 4 000 char cap), `renderToolData` (hard cap).
- **UI:** `/assistant` (chat, per-answer tool chips, ticket cards with approve/reject),
  `/assistant/settings` (`settings.company.manage`; the key is entered as an **env var name**,
  never a secret), nav entry behind the tenant switch. i18n: 22 `errors.ai*` keys + a new `ai`
  section in **both** dictionaries, enforced by a coverage test that scans the module.

### Commands executed → results

| Command | Result |
|---------|--------|
| `npm run typecheck` | ✓ clean after every step |
| `npx vitest run tests/unit/ai-assistant.test.ts` | ✓ 12 tests (guardrails, registry boundaries, i18n coverage) |
| `npx vitest run tests/integration/ai-assistant.test.ts` | ✓ 14 tests (permission matrix, cross-tenant args, injection, tickets, audit) |
| `npm test` (full gate) | ✓ **20 files / 170 passed / 8 skipped / 0 failed** (~22 s) |
| `npx next build` | ✓ "Compiled successfully in 14.0 s"; `/assistant` and `/assistant/settings` compiled |
| `npm run backup:run` | ✓ verified run `01a141fd-009a-73fe-80af-018a948951e5` — 81 tables / 1 558 rows, artifact 1 281 387 B, plaintext sha256 `0ffacb80…`, remote `local-contract` verified |
| `npm run backup:drill` | ✓ passed — 81 tables / 1 558 rows restored into `restore_drill_mva73xtv`: 51 posted entries balanced, 68 tenant-owned tables partitioned, 15/15 sampled rows, 201 audit rows hashed, 149 FKs satisfied, 227 policies present, **RTO ≈ 1.3 s** |
| HTTP smoke (live session cookie) | ✓ `/assistant` 200 (chat box, tool chips, ticket card, approve/reject), `/assistant/settings` 200, `/dashboard` 200, `/api/health` 200; sidebar link `/assistant` present |

### Defects found by the Phase 9 suites (all fixed, all re-verified)

1. **Kill-switch bypass by any other global flag.** `aiGloballyEnabled` built its predicate as
   one raw string: `key = 'ai_assistant' and tenant_id = $1 or tenant_id is null` — SQL reads
   that as `(key = … and tenant_id = …) or tenant_id is null`, so **every** global flag row
   became a candidate and the first one decided the answer. With `ai_assistant` switched off,
   the assistant still served the tenant because an unrelated `test_flag_*` row was enabled.
   Fixed with explicit `and(eq(key), or(eq(tenant), isNull(tenant)))`; proven by re-running
   the kill-switch test with those rows present.
2. **`renderToolData` exceeded its own cap** (6 003 chars for a 6 000 contract — the appended
   `…"}` was not subtracted). Fixed; the unit test now asserts the cap exactly.
3. **`wrapUntrusted` did not neutralize its own close marker inside content.** A memo
   containing `<<<END_UNTRUSTED_DATA>>> …` closed the untrusted block early and let the rest
   read as system text — the exact breakout the delimiters exist to prevent. Now
   `<<<`/`>>>` become `‹‹‹`/`›››`, with an `isWrapped()` assertion in the tests.
4. **Provider round trip dropped the assistant's tool-call blocks**, so the `tool`/`tool_result`
   messages that follow had no `tool_calls`/`tool_use` to answer — invalid conversations for
   both APIs on the second round. Fixed in both adapters (`ChatMessage.toolCalls`).
5. **`tenancy.rls.test.ts` hard-coded `grant connect on database app_db`** and failed wherever
   the database is named differently (the sandbox PGlite instance). Now reads
   `current_database()`.

Design corrections made while driving the tests: the propose-tool `intent` is validated as a
*free string against the registry* (an enum in the schema made the "unknown intent" security
signal unreachable), and `stock_variance_explain` now returns `recentMovements` with memos
**only** under `names_allowed` — which also gave the tool-output injection case a real source
instead of a synthetic one.

### Residuals moved forward (explicitly not done)

1. **No live provider exchange anywhere**: adapters are exercised through a scripted provider;
   `ASSISTANT_API_KEY` in `.env` is a documented placeholder, so the preview shows the honest
   unavailable answer when a message is actually sent.
2. **Retention is configured, not enforced**: `retentionDays` is stored and shown, but no job
   purges old threads yet (tool-call audit and injection flags already outlive the transcript
   by design — proven by test).
3. No streaming answers, no document/attachment ingestion (§6 treats such content as data-only
   *when* it exists), no per-tenant provider-terms text in the settings screen (§5).
4. Token usage is not metered into `usage_metrics` yet.
5. Asking is open to any tenant user (each tool is permission-checked, and tickets still need
   the intent's permission to execute); a dedicated `ai.use` permission is not introduced.
6. `test_flag_*` rows left by older suites are not swept — they are legitimate global flags,
   but the incident above is a reminder that flag *keys* must never be matched loosely.

### Exact next step (Phase 10 — UX completion, hardening & release readiness)

1. RTL/bilingual + accessibility + status-semantics audit across the new `/assistant` screens.
2. Implement the retention purge job (Phase 9 residual 2) and metering (residual 4).
3. Re-run the acceptance list of TESTING_AND_ACCEPTANCE.md end-to-end; re-drill the restore.
4. Deployment/rollback + operational runbooks; release-readiness report with evidence.

---

## Session 10 — 2026-10-16 · Phase 8 (platform administration & backups) implemented, console reachable end-to-end

### Status: Phase 8 implemented ✅ · AC-030 recorded as environment-limited (pg_dump / off-site) · 4 documented residuals

> **Continuation note:** the workflows were then driven end-to-end by
> `platform-ops.test.ts`, which found and closed **thirteen** real defects (row-duplicating
> capture, drill bound to the live tables, silent index loss, an unusable export link, a
> silently lost deletion certificate, …). See "Continuation (same session)" below.

> **Honesty note:** a backup run is labelled `verified` only after its artifact was re-read
> and checksum-matched; a check that cannot run is `skipped`, never a pass. The console shows
> counts, statuses and **declared** plan prices — never a tenant amount. Remote upload in this
> sandbox runs the explicit `local-contract` transport and is not presented as off-site storage.

### Work completed

1. **Platform tier** (`src/modules/platform/`): separate user store + roles (`owner`, `ops`),
   own session namespace (`hisab_platform_session`, 8 h) that refuses tenant tokens and vice
   versa, mandatory TOTP for owners, login throttling (5/300 s email, 20/300 s IP, 15-min
   lockout), 21 permission codes split view/manage, append-only hash-chained
   `platform_audit_log` with a `verify_platform_audit_chain()` re-check.
2. **Tenant lifecycle** `create → trial → active ⇄ suspended → deactivated`, implemented as
   *status*, never as deletion: suspension flips the tenant to read-only at the transaction
   level (read-only transaction + `app.read_only` restrictive RLS) so history stays visible and
   exportable. `purgeTenant` (request → export offer → typed confirmation → cooling-off →
   legal hold → certificate) is the only path that removes rows, and it is the only caller of
   `deleteTenantRows` (FK join sweep → every `tenant_id` table → `tenants`).
3. **Plans, entitlements, quotas, flags**: entitlements resolved per tenant, `assertQuota` at
   the write boundary with a warning band (`{metric,limit,used,increment}` in the error meta),
   global and per-tenant flags that take effect immediately and are audited.
4. **Backups** (`backup/{snapshot,crypto,invariants,pgdump,drive,service}.ts`): capture inside a
   single `repeatable read, read only` transaction; AES-256-GCM artifacts; a per-table content
   hash and the plaintext sha256 in `backup_runs`; `verifyBackup` stages
   `artifact_present | artifact_checksum | decrypt | plaintext_checksum | content |
   referential_integrity | remote`; pruning by retention class; freshness as a **blocker** in
   `/api/health`; `runRestoreDrill` restores into an isolated `restore_drill_*` schema, checks
   7 invariants (133 FKs, 227 RLS policies) and drops the schema.
5. **Console** (`/platform`): dashboard, tenants + tenant detail (lifecycle, plan, flags,
   quotas, grants, exports, deletion, per-tenant audit), plans, flags, backups, alerts
   (acknowledge/assign), audit trail, exports. Break-glass support grants (approver chain,
   scope, ≤24 h, masking, exports blocked, every view audited, tenant-visible); tenant export
   bundles (manifest v1 + sha256 + expiring token, checksum re-verified on download).
6. **Defect sweep of the console itself** (found by HTTP smoke, not by types): all console
   pages returned `500` for an `ops` session because pages requested permission codes that did
   not exist (`platform.plans.view`, `platform.flags.view`, `platform.backups.view`,
   `platform.alerts.view`, `platform.exports.view`); server pages imported **values** from
   `"use client"` modules (`fmtDate`, `statusTone`, `fmtBytes` — "Functions cannot be passed
   directly to Client Components"); a client function was passed as the `render` prop from a
   server page; and the dashboard queried `subscriptions.status in ('trial','active')` while
   the enum value is `trialing`. All fixed; the shared formatters now live in
   `src/app/platform/format.ts` (no `"use client"`), and a test locks the boundary
   (`platform-admin.test.ts` → "every console screen asks for a permission the catalog
   actually defines": codes exist, `ops` can open every screen, owner holds everything, and no
   server page imports a lower-case value from a client module).
7. **Hygiene**: the tenant permission catalog must not carry `platform.*` codes (platform
   roles are not tenant permissions) — seed reconciles both stale grants and stale rows; test
   teardown **retires** operator accounts (disabled + signed out) instead of hard-deleting them,
   because their ids are referenced by the append-only audit chain.

### Commands executed → results

- `npm test` → **17 files passed | 134 passed | 8 skipped (142) | 0 failed**; `npx tsc --noEmit` clean; `npx next build` succeeded (41 s, all routes rendered).
- `npx tsx scripts/platform-backup.mts run` → `verified`, `logical-json`, 75 tables / 4387 rows, plaintext 2 042 346 B, artifact 2 723 179 B, plaintext sha256 `2cf99a0c…`, artifact sha256 `b065e0e8…`, remote `local-contract`, 731 ms.
- `GET /api/health` → `200 {"ok":true,"db":true,"worker":{"status":"stopped"},"backup":{"state":"fresh","ageHours":0,"thresholdHours":8,"blocker":false},"blockers":[]}` (was `503 backup_stale`, caused by a test that never restored timestamps — fixed with `try`/`finally`).
- Console smoke over HTTP with a live platform session: `/platform`, `/tenants`, `/tenants/[id]`, `/plans`, `/flags`, `/backups`, `/alerts`, `/audit`, `/exports` → **all 200**; without a session → `307 /platform/login`; `/api/platform/export/[id]` → `401` unauthenticated, `400 errors.notFound` for an unknown id.

### Incidents fixed with lasting rules

- **Types cannot see the Server/Client boundary.** A server page importing a formatter from a
  `"use client"` module compiles and 500s at runtime; the same is true for function props.
- **A permission code that does not exist is indistinguishable from a denial** — and it denies
  the owner too. Codes requested by the console are now asserted against the catalog, and
  `ops` must be able to *open* every screen it can see.
- **Reading and changing are separate rights**: `.view` codes exist for every screen; `ops`
  never gets a destructive one.
- **Test teardown must respect the invariants it tests**: hard-deleting an operator account
  fails the audit FK (and would erase accountability) — retire it instead.
- **A test that mutates global rows must restore them** (backup freshness left the live
  instance `stale` for 40 h; now captured and restored in `finally`).
- **Platform-scoped tables must be excluded from tenant partitioning checks** — mirrored at
  capture time (`isPlatformScopedCapture`) so the invariant and the capture agree.

### Residuals moved forward (explicitly not done)

1. `pg_dump --format=custom` path unexecuted here (no client binaries); every run records
   `format = logical-json`.
2. Remote backup is the `local-contract` transport — no Google Drive credentials, so **no
   off-site backup claim**.
3. Console mutations are driven at the module layer in tests; no browser-level form post was
   exercised (no browser in the sandbox) — the exports download route was exercised over HTTP.
4. `/platform` is reachable in the preview but the seeded owner must enrol TOTP before first
   sign-in; tenant-side ZATCA residuals (AC-025, OQ-2/3/4) are unchanged.

### Continuation (same session) — the workflows, and the defects only executing them could find

A new suite (`tests/integration/platform-ops.test.ts`, 10 tests) drives the data-lifecycle
workflows the earlier suites did not: export bundles and their download link, the whole
deletion chain, feature flags, the alert inbox, usage metering, rate limits, settings, and the
honesty of the remote transport label. Writing it exposed **thirteen real defects**, all fixed:

1. **The snapshot duplicated rows.** The chunked capture paginated on `max(ctid::text)`, which
   compares *lexicographically* — `(9,99)` beat `(10,1)` — so every chunk after the first
   re-read a range of rows it had already captured. `role_permissions` was captured as 3641
   rows for 2355 real ones. The artifact was internally consistent (its hashes covered the
   duplicates), so `verify` passed; only replaying it into a schema with primary keys caught
   it. Fixed to `max(tid)::text`; a fresh capture of 8598 rows now contains **zero**
   duplicates.
2. **The restore tested the wrong copy.** `pg_get_constraintdef` omits the schema when the
   referenced table is on the capture session's search path, so a captured FK read
   `REFERENCES tenants(id)` — and the drill replayed it against the **live** `public` tables.
   It therefore "passed" while the live database matched the snapshot and failed the moment it
   legitimately moved on. The restore now rewrites every reference to the target schema.
3. **Keys were added after the foreign keys that need them.** Constraints were replayed in
   manifest order, so `accounts`' FK to `tenants` ran before `tenants` had a primary key
   (`42830`). Now: keys/unique/checks first, then FKs, retried until no further progress is
   made.
4. **Indexes could vanish silently.** Index replay failures were logged and ignored; they are
   now returned as `skippedIndexes` and reported as a first-class `indexes` check on the drill
   (which fails the drill).
5. **The purge could not run for a tenant that had touched the platform.** The FK-sweep in
   `deleteTenantRows` wrote `p.tenant_id` against *any* parent without a `tenant_id` column
   (e.g. `platform_users`), dying on `42703` — and it was willing to sweep platform-wide
   tables. The sweep is now restricted to tenant-scoped parents and skips `platform_*`/
   `pgboss*`; the audit chain is never tenant data.
6. **The deletion certificate was silently lost.** `deletion_requests.tenant_id` was
   `not null` + `on delete restrict`: the purge deleted its own register row and then updated a
   row that no longer existed. The register now outlives the tenant (`set null`), the console
   renders a tenant-less row, and a second purge is refused
   (`errors.deletionAlreadyPurged`).
7. **`on delete set null` never fires during a purge.** `session_replication_role = replica`
   disables RI triggers, so the surviving register kept dangling references and a later restore
   (rightly) refused to rebuild them. The purge now releases them explicitly; the rows left
   dangling before the fix were cleaned once.
8. **Export links never worked.** `buildTenantExport` returned a random token while
   `downloadTenantExport` verified an HMAC of `id.expiry` (and the stored token hash was never
   consulted), so every token-based link failed with `errors.permissionDenied`. One token is
   now minted in the verified form *and* stored hashed, so the link works and stays revocable.
9. **Usage metering ran against a column that does not exist** (`representatives.status`), so
   `captureUsageForTenant` threw on every run — the console's usage numbers could never be
   filled.
10. **Acknowledged alerts were never resolved** (`resolveAlerts` only closed `open`), so a
    cleared condition left an open alert forever.
11. **Flag changes did not name the flag** in the audit payload (only in the entity id), and
    **settings changes were audited only by the console action** — a script or job could change
    retention/cooling-off silently. Both now carry their evidence in the module.
12. **The console dead-ended a stale session.** A revoked/expired cookie (or a disabled
    account) produced a bare 404; it now redirects to `/platform/login?expired=1`. The
    enrolment page without a pending token returns to sign-in, and the pending-token cookie
    name moved out of the `"use server"` module (a `"use server"` file may only export async
    functions — importing a constant from it fails at runtime).

13. **A purged tenant's export bundle stayed on disk.** The bundle is a full copy of the
    tenant's data, and the purge removed the database rows but left 21 files in `.exports/`
    (the dev directory held 30 bundles from test tenants, two of them already purged). The
    purge now collects the tenant's artifacts (recorded paths + a name sweep as a backstop),
    deletes them, and records `exportArtifactsRemoved` on the certificate.

**Evidence after the fixes:** `npm test` → **18 files / 144 passed | 8 skipped | 0 failed**;
`tsc --noEmit` clean; `next build` ok; `backup:run` → `verified` (logical-json, 75 tables /
8599 rows); `backup:drill` → **passed** in 1.8 s with 8 checks (75 tables / 8599 rows
restored, 133 FKs rebuilt, 227 policies intact); `/api/health` → `200` fresh.

### Updated residuals

1. `pg_dump --format=custom` path unexecuted here (no client binaries); every run records
   `format = logical-json`. New: the capture/restore path is now proven on ~8.6k rows in 75
   tables, but never against a multi-gigabyte database — RTO on such a database is unmeasured.
2. Remote backup is the `local-contract` transport — no Google Drive credentials, so **no
   off-site backup claim**.
3. Console mutations are driven at the module layer in tests; no browser-level form post was
   exercised (no browser in the sandbox) — rendering, guards and the export download route
   were exercised over HTTP.
4. `/platform` is reachable in the preview; the seeded owner (`admin@hisab.sa`) is not yet
   TOTP-enrolled, so the first sign-in walks through the enrolment flow. Tenant-side ZATCA
   residuals (AC-025, OQ-2/3/4) are unchanged.

### Exact next step (Phase 9)

AI assistant per roadmap: provider adapters, permission-aware read-only tool registry, approval
tickets for mutations, conversation/tool audit, privacy data-minimization table.

## Session 9 — 2026-10-16 · Phase 7 (reporting & reconciliation) implemented, catalog wired to the app

### Status: Phase 7 implementation COMPLETE for the reports whose sources exist ✅ · 2 documented residuals (see below)

> **Honesty note:** every figure in the catalog comes from ONE authoritative table set
> (INV-13). Nothing is derived twice, nothing is estimated, and a report whose data does
> not exist in this build says so instead of printing a plausible zero.

### Work completed

1. **Report services** (`src/modules/reports/`, all tenant-scoped and `business_date`-filtered):
   `ledger.ts` (trial balance w/ opening+closing, general ledger/statement w/ running
   balance from opening, account tree rollups, balances-by-type),
   `receivables.ts` (AR/AP aging in current/1–30/31–60/61–90/90+ buckets, outstanding
   documents), `inventory.ts` (stock on hand/availability, movement ledger, valuation,
   expiry bands, low-stock/slow-moving), `tax.ts` (taxable sales by category/rate,
   output-vs-input VAT, submission status + action queue, note references, ZATCA audit),
   `sales.ts` (sales by dimension, cash-vs-credit, returns & discounts, free goods,
   collections, income statement, profitability with a coverage gate),
   `ops.ts` (journal report, cash & bank, expenses, period comparison, settlement history,
   open exceptions), `reconcile.ts` (RL-1…RL-5 + documents-without-postings audit +
   dangling-reversal audit), `index.ts` (one dispatcher + catalog for page/CSV/drill-down).
2. **`/reports` page + CSV export** (`/reports`, `/reports/export` route handler):
   the RL-1…RL-5 integrity banner is rendered ABOVE the report (a breach is impossible to
   miss and is never masked), reports are grouped by catalog order, filters are
   `from`/`to`/`asOf`/dimension/account/warehouse/…, drill-down works (trial balance →
   general ledger, aging → outstanding documents) and CSV export is a permission
   (`reports.export`) and is **audited** (`reports.exported`). Financial statements are
   gated on `reports.financial.view`; `/reports` nav entry enabled.
   The export runs the SAME dispatcher as the screen, so a downloaded file cannot
   disagree with what the viewer saw.
3. **Role-aware dashboard** (`/dashboard`): the tenant's financial snapshot
   (month revenue/expense/result, open receivables, inventory value at cost) is shown to
   `reports.financial.view` holders, the integrity chip to `reports.view` holders — using
   the same services as `/reports`.
4. **Acceptance tests** (`tests/integration/reports.test.ts`, 12 tests) against a chaos
   fixture (cash + credit sales, zero-rated/exempt/free lines, a credit note, a partially
   allocated receipt, a purchase with input VAT, a partial supplier payment, a manual
   entry **and its reversal**, plus a draft that must never be counted):
   the trial-balance footer ties to the raw ledger; documents tie to the ledger
   (revenue = gross − discounts − returns, VAT from lines); RL-2/RL-3/RL-5 tie to the
   control accounts; every catalog entry runs through the dispatcher and every column /
   title exists in **both** dictionaries; drafts never appear; profitability withholds
   margins when cost coverage is incomplete; a valuation↔control difference names the
   movement that caused it.

### Decisions recorded during this session

- **Subledger document set is read from the postings, not guessed.** AR/AP aging includes
  exactly the documents whose journal entry touched the control account, with the sign of
  their own posting (a sale to a registered walk-in *does* debit AR; a credit note credits
  AR even when the original was a walk-in sale). Allocations are then subtracted, so
  `Σ signed documents − Σ allocations = control balance` by construction. Deriving the set
  from `is_credit`/`customer_id` was tried first and produced a −31.05 drift on the seeded
  tenant — the postings-derived set reconciles exactly (345.00 = 345.00).
- **Returns are signed, never double counted:** report totals net credit notes exactly the
  way the ledger does (documents carry the net, the ledger carries gross + contra accounts).
- **Control accounts are resolved through the mapping contract** (`postingMappings` key →
  account, code only as fallback), never by hard-coded id.
- **Coverage over fabrication:** R-12 prints a coverage banner and refuses a margin when
  cost data is incomplete; R-42 reports uncosted rows; the VAT report says when posted
  documents have no journal entry.

### Residuals (recorded, not worked around)

1. **R-05 cash flow, R-10 bank reconciliation, R-24 price-override attempts, R-27
   commission, R-29 partial, R-46…R-51** are listed in the catalog as `status: "pending"`
   with the reason; the UI shows the reason and no numbers. They need either data that
   this build does not capture (statement import, rejected override attempts, commission
   rules) or Phase-8 cost closure.
2. **PDF export** is not implemented. CSV + **XLSX** are (`?format=xlsx`; the sheet is
   RTL, numbers stay numeric, Arabic is written as inline strings, and the same dispatcher
   feeds it — `src/modules/reports/xlsx.ts`, dependency-free ZIP+OOXML, verified by
   `tests/unit/xlsx.test.ts` and read back with an independent ZIP parser). Arabic-correct
   PDF needs a shaping + font-subsetting renderer, which is not in the dependency set, so
   it is recorded rather than half-built.
3. **Filters**: date range, `asOf`, account, warehouse, dimension and slow-days are wired;
   branch/cost-center/project filters on the journal-based reports are not yet exposed in
   the UI even though `journal_lines` carries those columns.
4. **Demo-tenant integrity banner is RED for RL-3 — and that is a true finding:** the
   seeded tenant (`owner@horizon.test`) receives movements from the integration suites
   that write stock directly (source types `test`/`import`), so ~11.9k of stock value has
   no journal effect on the inventory control account. The banner names the count/value;
   report figures for that tenant are not trustworthy until those movements are cleaned
   up. A user-created tenant reconciles clean (the chaos fixture asserts zero breaches).
   CLI: `npx tsx scripts/reports-check.mts owner@horizon.test`.

### Gate (after closure)

```
npx tsc --noEmit                                        ✓ clean
npx vitest run tests/integration/reports.test.ts        ✓ 12/12
npx vitest run tests/unit/xlsx.test.ts                  ✓ 6/6   (ZIP read back independently)
node scripts/db-reset.mjs && npm test                   ✓ 15 files, 115 passed | 8 skipped
next build                                              ✓ /reports + /reports/export, exit 0
curl /reports/{R-02,R-03,R-04,R-05,R-08,R-12,R-20,R-42,R-62,R-66}  ✓ 200
curl /reports/export?report=R-60[&format=xlsx]          ✓ 200 (CSV + valid XLSX)
npx tsx scripts/reports-check.mts owner@horizon.test    ✓ RL-1/2/4/5 OK, RL-3 names its cause
```

---

## Session 8 — 2026-10-16 · Phase 6 COMPLETE (onboarding automation + final XML details) → Phase 7 next

### Status: Phase 6 COMPLETE ✅ (AC-025 recorded as environment-limited, not "passed")
> **Compliance framing (binding, unchanged):** sandbox-validated architecture ONLY. Not
> production-certified, not legally compliant by association. No FATOORA sandbox
> credentials exist in this environment and none were fabricated; the real portal
> exchange is **unverified** and AC-025 says so explicitly (TESTING §3.1).

### Work completed

1. **Onboarding automation (the step that used to be a documented manual capture)** —
   `src/modules/tax/onboarding.ts` + four server actions + `/tax` `OnboardingPanel`:
   EGS key pair + CSR (official SDK property set/OIDs, template per environment) →
   `POST /compliance` with the portal OTP → the **six mandatory compliance documents in
   platform order** (standard I/credit/debit → simplified I/credit/debit, 100.00 net at
   15%) → `POST /production/csids` → `PATCH /production/csids` renewal, with the whole
   run journaled (`zatca_compliance_checks`: icv, previous_hash, xml, qr, attempts,
   validation status) and a read model feeding the UI. Guard: the production CSID is
   refused until all six kinds have a `passed` row (`errors.taxComplianceChecksIncomplete`
   with the missing kinds). Manual credential capture survives as a settings-only
   fallback (`t.taxPg.manualFallback`).
2. **Real cryptography in the credential path** — the gated contract fake issues an
   ACTUAL X.509 certificate from the local EGS CA (`local-ca.ts`), persists the key pair
   it certifies, and every compliance document is self-verified
   (`digestValid`/`signedPropertiesValid`/`certificateDigestValid`/`signatureValid`)
   before submission. No fake tokens, no fabricated acceptance: the fake refuses unsigned
   or naked documents and returns FAIL.
3. **Final XML details closed with the compliance cycle** — Delivery/ActualDeliveryDate
   and the PaymentMeansCode table were already rule-keyed; this session closed the
   decimal-precision and category work: BR-KSA-DEC-01..05 now evaluate the **emitted
   document** (in-memory money buffers legitimately carry more places), BR-KSA-CL-05
   enforces the *approved* KSA exemption text for the chosen code (not merely presence),
   and line-level Z/E/O are covered end-to-end (`E` line + subtotal pair from the tenant
   ruling; `O` line without `cbc:Percent`, matching the SDK samples; absent tenant
   ruling = blocking `ConfigurationError`, never a silent exemption).
4. **Test hygiene that was hiding real signal**:
   - `vansales` `balance()` helper asserted a stock-balance row that does not exist yet
     (fresh custody warehouse) → tolerant query; the 5 chronic failures were the helper,
     not the app.
   - `isSharedSessionEngine()` (tests/helpers/db-engine.ts) detects a DB engine that
     serves every logical connection from ONE backend session (the sandbox PGlite
     gateway). Savepoint/rollback leak across connections and role switching is a no-op
     there, so the idempotent-replay/concurrency and RLS suites now report **skipped**
     with a documented reason and run for real against a normal PostgreSQL server.
   - `tests/unit/tax-i18n.test.ts` collects every `errors.*`/`taxPg.*`/`tax.validation.*`
     key from the source and asserts it resolves in BOTH dictionaries (45 validator keys
     had no translation at all before this session).
   - `npm test` / `npm run test:unit` scripts added (`vitest run --no-file-parallelism`).

### Commands executed → results

| Command | Result |
|---------|--------|
| `node scripts/dev-postgres.mjs --port 5432 --dir /tmp/pglite-data --max-connections 80` | ✓ live (PID 2274) |
| `node scripts/db-reset.mjs` (×3) | ✓ drop schema → drizzle push → rls.sql → seed |
| `npx next typegen` / `npm run lint` / `npx tsc --noEmit` / `npm run build` | ✓ all green (build 12.5 s compile) |
| `npm test` (fresh DB) | ✓ **97 passed / 8 skipped / 0 failed** (13 files; skips = PGlite engine limits) |
| `npx vitest run tests/integration/zatca-onboarding.test.ts` | ✓ 5/5 — full CSR→compliance→pCSID→renewal cycle, PIH chain, guards, no-credential-leak status |
| `npx vitest run tests/integration/tax.test.ts` | ✓ 8/8 — incl. QR tag 8/9 cross-checked against the X.509 certificate, BR-KSA-63 no-fabrication, exempt-line ruling |
| `npx vitest run tests/unit/zatca-signature.test.ts` | ✓ 15/15 — incl. mixed S/Z/E/O line document and CL-04/CL-05 pairing |
| `openssl x509 -inform DER` / `openssl req -inform DER` (probe) | ✓ generated EGS certificate + CSR parse (secp256k1, TSTZATCA-Code-Signing) |

### Incidents fixed with lasting rules

- **Validator false positive (was putting real submissions into `blocked_config`)**: the
  line-precision rule rejected the in-memory `lineNet` buffer (legitimately > 2 decimals)
  while BR-KSA-DEC-03 governs the *document's* `TaxTotal/cbc:TaxAmount`. Rule of thumb
  adopted: **document rules read the rendered XML; buffers are not evidence.**
- **BR-KSA-50 unit mismatch**: `vatRate` is the UBL percent value ("15"), so line VAT =
  `round2(lineNet × vatRate / 100)` — the old fraction assumption blocked every taxed
  line. The category-with-positive-rate guard is our own rule (`HISAB-CAT-RATE`), not a
  mis-cited DEC-02.
- **QR tag 8 is X.509 SPKI DER (88 bytes for secp256k1), not the raw 65-byte point**, and
  tag 9 is the certificate's own signature. Proven from the SDK samples
  (`Standard/Simplified_Invoice.xml`) and now cross-checked against the certificate in
  the integration suite.
- **PGlite is single-backend**: it also explains the intermittent
  `Received unexpected commandComplete message from backend` and the run-to-run
  accounting/RLS failures. Re-run before diagnosing, and mark — do not "fix" the app.

### Residuals (explicit, gating)

- **Sandbox FATOORA end-to-end** (developer-portal → simulation → core) stays unverified:
  requires an OTP + CSID from a registered taxpayer. AC-025 exit condition recorded
  (TESTING §3.1); no production-compliance claim anywhere.
- Compliance-run PIH/ICV chain restarts from genesis per run (`COMP-*` fixtures) — the
  production chain starts from the first real document (by design, documented).
- SignedProperties c14n context vs the SDK sample digest still open (the sample's own
  Reference uses absolute `URI=""`, undereferenceable by `xml-crypto`); our generated
  documents verify completely.
- OQ-2/OQ-3/OQ-4 remain OPEN legal inputs — no silent resolution in code.

### Exact next step (Phase 7)

Reporting & dashboards per REPORTING_SPECIFICATION.md: reports in priority order with
formula-verification tests on the chaos fixture (incl. reversals) — every figure must
reconcile with the authoritative ledgers, one source per figure, `business_date` filters,
drafts excluded, reversals first-class (no double counting).

## Session 7 — 2026-10-15 · Phase 6 (electronic invoicing & ZATCA compliance)

### Status: Phase 6 PARTIAL — core complete; portal automation (CSR/compliance-checks) deferred
> **Compliance framing (binding):** sandbox-validated architecture ONLY.
> Not production-certified. Not legally compliant by association. Real onboarding
> against FATOORA (CSR → compliance checks → production CSID) and the legal
> questions OQ-2/OQ-3/OQ-4 remain open gating items before any production claims.

### Work completed

1. **Research-grounded integration (D-012 honored)** — endpoints/auth/headers verified
   against the official developer documentation (research evidence in session; constants
   configurable here: developer-portal / simulation / core base URLs +
   {compliance, compliance/invoices, production/csids, invoices/reporting/single,
   invoices/clearance/single} + Basic BST:secret + Accept-Version V2 + Clearance-Status).
2. **Tax config & gating**: seller identity readiness (legalName + 15-digit VAT + city +
   postalCode) with blocking ConfigurationError naming the missing fields; doc-type
   classifier (15-digit tax-registered buyer → standard=c clearance, otherwise
   simplified=reporting; returns inherit credit_note); free-goods deemed-supply policy
   flag (OQ-4, pending advisor — default non-deemed);
3. **Signed e-invoice issue inside the posting tx**: UBL 2.1 KSA XML generation
   (supplier/buyer/ICV/PIH/QR/signature-container) with documented normalization for the
   SHA-256 hash; **secp256k1 device keys sign the hash**; ICV+PIH chain under row lock
   (gapless per tenant); TLV QR (simplified tags 1–9 with real signatures; standard tags
   1–5). **Unsigned QR is NEVER emitted — blocked_config instead (no fabrication).**
4. **Submission engine + transport boundary**: invoiceSubmissions journal (uuid, icv,
   hash, xml, qr, signature, response, attempts, error classes); HttpTransport per
   official spec; MockTransport runs only behind ZATCA_TRANSPORT=mock/NODE_ENV=test and
   performs REAL validation (hash recompute, uuid) — processors: pending→reported/
   cleared/rejected/failed_retryable with mirror to invoice.tax_status (orthogonal dim),
   retries keep the SAME uuid/ICV/XML (INV-02), rejected needs correction via new doc.
5. **Wiring**: invoice post + return post create submissions in the SAME transaction;
   worker queue `zatca-submission` every 5 min (boss retries with backoff for transports);
   manual retry only for failed_retryable; tax config fully audited before/after.
6. **Offline legal constraint (verschärfed by actual work)**: rep POS blocks queuing a
   standard-document sale (buyer has VAT) while offline with an explicit Arabic notice —
   consistent with OQ-3 (standard invoices require clearance = connectivity).
7. **UI**: `/tax` — readiness checklist with blockers, env config, address form,
   onboarding panel (device-key generation + credential capture with rotation), status
   cards (pending/reported/cleared/rejected/failed/blocked), submissions table with
   retry + last-error + attempts, VAT summary from GL.
8. **Tests** (`tax.test.ts` 6/6 ×3): classification, signed XML + chain continuity
   (authoritative chain row), hash recompute, real TLV parts order/values (65-byte
   pubkey, non-empty sig), standard clearance_pending + 5-tag QR, mock processing
   reported/cleared + mirror, **integrity-anomaly rejected path**, retry uuid/icv
   preservation, blocked_config with local_draft mirror, disabled→no submission,
   **missing seller config blocks posting while draft survives** (INV-17).

### Commands executed → results

| Command | Result |
|---------|--------|
| web research (official endpoints/environments) | ✓ evidence captured in transport constants |
| drizzle-kit push (+2 hash-widening fixes) + rls.sql reapply | ✓ 4 tax tables + refined trigger |
| vitest tax suite ×3-alone + **full regression ×2 parallel** | ✓ **80/80 stable** (10 files) |
| typegen/lint/tsc/build/build_and_start | ✓ all green; /tax deployed |

### Incidents fixed with lasting rules
- Posted-invoice immutability was over-broad: DB trigger refined to allow ONLY
  `tax_status` transitions on posted invoices (bit-identical elsewhere) — INV-03/INV-10 reconciled.
- hash columns sized 80→96 (base64 hex64 = 88 chars).
- Test methodology final form: chain assertions INSIDE the tenant lock; business-date-scoped
  GL counts; RUN-scoped material stocks (parallel-suite interference eliminated).

### Residuals (explicit, gating)
- **CSR generation + compliance-CSID + 6 compliance checks + production CSID automation**
  (portal flow exists today via documented manual credential capture; automation next).
- Sandbox FATOORA end-to-end verification cannot be done without tenant credentials —
  environment-limited per TESTING doc §2 (adapter covered by contract fakes).
- CSR uses ZATCA custom OIDs (egs SN, UID, invoiceType, location, industry) — to
  implement from the current official CSR guidance at that point (no invention).
- XML details (Delivery, PaymentMeansCode table, exempt vs zero categories on line level)
  land final with the compliance checks cycle.
- OQ-2/OQ-3/OQ-4 still OPEN legal inputs — no code-level silent resolution permitted.

### Exact next step (Phase 7)
Reporting dashboards & suites per REPORTING_SPECIFICATION: implement reports in priority
order with formula-verification tests (chaos fixture incl. reversals/transfers/returns/
settlements): TB, GL, account statements, AR/AP aging, stock valuation ↔ GL assertion,
VAT reconciliation, rep/custody report, then export (CSV) + drill-down links.

### Status: Phase 5 core complete ✅ (residuals listed) — next: Phase 6 (ZATCA/e-invoicing)

### Work completed

1. **BOMs**: versioned recipes (new version deactivates prior; orders may reference any
   existing version — rule documented after an invalid-rejection bug), per-batch yields,
   component qtys.
2. **Production lifecycle**: planned → in_progress → completed (+cancelled), PR numbering
   at start, **concurrent double-start idempotent** (no double consumption; the guard is
   the status transition + embeds), planned vs actual consumption with overrides at start.
3. **Cost engine (D-009/FR-028 proven)**: consumption posted at ACTUAL issue cost (FEFO
   lot cost where tracked) as Dr production_clearing/Cr inventory (P-17); labor/overhead
   components as Dr clearing/Cr accrued (P-19); scrap removes value from the clearing into
   scrap-expense (normal 5104) / abnormal-losses (5105) — never silently absorbed into
   unit cost nor double-counted; **completion computes unit cost = GL clearing basis /
   actual output qty** (3.1579 verified = 300/95), Dr finished-inventory/Cr clearing
   (P-18); zero/missing basis → blocking ConfigurationError (`productionCostMissing`,
   order stays in_progress); completed orders immutable at DB.
4. **Genealogy & recall (FR-027)**: finished lot (batch = PR-<orderNo>) links back through
   per-lot consumption ledger rows to material lots (B-FLOUR-2601 etc.) and forward to
   sales/customers — tested end-to-end including a sale of the produced lot.
5. **Variance view**: planned vs actual consumption value/qty, components totals, yield %
   (95.00 verified), per-order clearing balance; UI cards surface all four figures.
6. **UI (Arabic RTL)**: `/manufacturing` — BOM builder (dynamic lines), order creation,
   per-state cards: planned (editable overrides + start/cancel), in_progress (consumables
   with actual lot costs, add labor/overhead, record scrap normal/abnormal, complete with
   output qty + expiry and computed cost display), completed (materials/components/unit
   cost/yield), plus RecallTrace widget (lot → BOM chain → sales). Permission
   `production.manage` added to catalog + production_manager/accountant presets; nav enabled.
7. **Tests** (`tests/integration/mfg.test.ts`, 6/6 ×2): version deactivation, full cycle
   math incl. WAC deltas, clearing balance at each step (225 → 300 → 0), scrap value
   removal (18.25 → 2.0278/unit), zero-cost block, genealogy chain, immutability.

### Commands executed → results

| Command | Result |
|---------|--------|
| drizzle-kit push + `psql -f src/db/rls.sql` | ✓ 6 mfg tables + completed-order immutability trigger |
| `npx tsx scripts/seed.ts` | ✓ permission 55 (+production.manage) |
| vitest mfg suite ×2 + full regression | ✓ 6/6 stable; **74/68→74/74** overall |
| typegen/lint/tsc/build/build_and_start | ✓ all green; `/manufacturing` live |

### Incidents fixed with lasting rules
- Rejecting inactive BOM versions for orders was wrong: orders may inherit older versions;
  `active` governs NEW default only.
- uuidv7 **time-prefix collisions struck twice more** (scrap effect kinds, sequential ops):
  adopted final rule — any effectKind/derived code must use uuidv7's random TAIL or a
  distinct random suffix; documented in DECISIONS-adjacent notes here (D-004 addendum).

### Residuals moved forward
- WIP balance-sheet account as an alternative to clearing-only (config flag).
- By-product/co-product outputs (single output per order now).
- Operation steps/routing & time tracking; capacity planning.
- Expiry-day report & stock aging dashboards → Phase 7 reporting bundle.
- Commission computation engine → Phase 7/8 bundle (rules exist as design only).

### Exact next step (Phase 6)
Tax identity config + FATOORA onboarding skeleton (compliance→production CSID,
sandbox-gated), XML/QR generation per official specs (implement strictly from official
ZATCA docs at that point — no invented endpoints), clearance (standard) / reporting
(simplified) flows wired to the invoice engine's tax_status taxonomy, submission status
pages + retries without duplicate issuance, and the offline-issuance legal constraints
(OQ-2/OQ-3 hard-blocks).

### Status: Phase 4 core complete ✅ (residuals listed) — next: Phase 5 (manufacturing & advanced inventory)

### Work completed

1. **Provisioning (AC-001/2 proven)**: employee→user→field_rep role→representative row→
   **custody warehouse auto-created idempotently** (DB unique (tenant, representative_user_id);
   sequential repeat = replay, concurrent double-assign = still exactly one — found fix:
   warehouse code uses uuidv7 random TAIL, not the time prefix). Deactivation blocks on
   non-zero custody; device registration/revocation with audit.
2. **Sync engine server-side**: `/api/sync/register|push|pull`. Ops applied per-op in
   own tenant tx with `idempotency_keys` PK dedupe; payload-hash mismatch on known op =
   **tamper reject** (never re-applied); business rejects persisted as replayable states;
   rep ops are **custody-scoped server-side** (warehouse forced; reps without custody get
   rejected, not applied); pull deltas: products/customers/prices/custody stock/rep
   invoices/transfers with cursors.
3. **Rep PWA (genuine offline-first)**: installable manifest + runtime-caching service worker,
   Dexie IndexedDB outbox with five states (pending/syncing/synced/rejected/conflict/tamper),
   stable op_ids (uuidv7) + sha256 payload hashes, push/pull cycle with backoff+jitter,
   online/visibility triggers, catalog + custody caches, local stock hint with
   "الخادم يتحقق نهائياً" warning; screens: home (custody value, provision self-onboarding),
   POS (queue-only invoice.create; local stock decremented optimistically), transfers
   inbox (accept via op), sync center (per-op status + errors in Arabic), settle request page.
4. **Settlement machine (D-022)**: requested → under_review → closed; unique open per rep
   (lock on representative row); openForReview computes authoritative figures (expected
   cash from rep receipts − approved rep expenses; expected stock from custody balances;
   pending e-payments surfaced as info exceptions); counts record diffs which auto-create
   **pending exceptions only** (never auto-debt, never auto-payroll); closing requires
   all exceptions explicitly approved (P-24…27: handover cash, per-exception stock
   adjustments with GL); concurrent close = exactly one winner; **closed settlements
   immutable by DB trigger**; rep notified with own results; accountant page /settlement
   with full review flow.
5. **Rerun-safe test methodology adopted**: run-unique entities + relative baselines
   (lesson from accumulated-state failures).

### Commands executed → results

| Command | Result |
|---------|--------|
| install dexie | ✓ |
| drizzle-kit push + `psql -f src/db/rls.sql` | ✓ 8 new tables + settlement immutability trigger |
| vitest `vansales.test.ts` ×3 consecutive | ✓ **7/7 stable** |
| full regression | ✓ **68/68** (8 files) |
| lint / tsc / typegen / build | ✓ all green (rep PWA routes + sync APIs deployed) |
| build_and_start + curl | ✓ health ok; /rep auth-gated; push without session = 401; manifest+sw served |

### Invariant evidence (executed tests)
AC-001/AC-002 ✓ · transfer double receive impossible (op replay + balance probe) ·
invoice op idempotent replay · **tamper (same opId, changed payload) rejected & untouched** ·
custody-scope rejection · allocation guard through ops (INV-09) · settlement: idempotent
request, exact expected-cash computation, counts→pending exceptions, close blocked while
pending, approved→closed with balanced GL + stock delta −2, **two concurrent closes exactly
one wins (AC-018)**, immutability at DB, rep notification present, **unapproved shortage
never touches employee-receivables (AC-016)**.

### Incidents fixed with lasting rules
uuidv7 prefix code collision (above) · `stock_ledger.effect_kind` varchar(40) exceeded by
`exception_<uuid>` → shortened key · shared i18n module leaked next/headers into client
bundles → split @/i18n (server) vs @/i18n/dicts (client-safe) · react-hooks/set-state-in-effect.

### Residuals moved forward
- Per-device credential tokens (v1 uses session + registered device binding).
- Partial/disputed transfer acceptance in rep UI (engine supports; UI shows accept-all).
- Playwright E2E for browser restart/resync; offline caps (count/value/age) are documented
  provisional in OFFLINE_SYNC §6 — server re-validates all business rules at apply time.
- Expense capture from rep PWA (approvable via expenses flow in ERP).
- Receipt share/print from rep POS (Phase 6 with tax layouts).

### Exact next step (Phase 5)
BOMs + production orders/batches; consumption at actual lot cost; finished-goods receipt
at computed cost incl. labor/overhead; scrap normal/abnormal; yield/variance; lot genealogy
for recalls. Start: schema (boms + production tables) + production cost engine + zero-cost
guards (D-009) + tests, mirroring settlement patterns.

### Status: Phase 3 core complete ✅ (residuals listed) — next: Phase 4 (representative workflow + offline sync)

### Work completed

1. **Parties**: customers (credit limit/terms/hold, tax no.), customer effective prices,
   suppliers; seeded (cash general customer + 2 credit customers + مطاحن الوسطى,
   treasury: صندوق رئيسي + بنك).
2. **Sales engine** (`sales/invoices.ts`): four status dimensions; draft vs post strictly
   separated (IZ §5 dialog contract); server-side pricing (customer price → product),
   boundary enforcement + override requires permission + mandatory reason (original
   price recorded, FR-037); free-goods lines (D-021: zero revenue, stock out at cost,
   expense account); VAT (standard 15%); walk-in cash (full-payment direct to treasury,
   no phantom AR); named-customer invoices always Dr AR with same-tx receipt settlement;
   credit limit/hold/terms (auto due date); idempotency via clientOpId pre-check +
   SAVEPOINT (concurrent duplicate submits collapse); returns capped at sold−returned,
   stock back at original COGS, credit-note GL (P-05), fully immutable posted invoices
   (trigger — paid/returned derived, never stored back).
3. **Receipts & allocations** (INV-08/09): per-invoice outstanding guard under row lock;
   advance remainder + apply-advance; multi-method payment lines; **card = pending
   settlement, never settled cash** (settle action flips status + audit only).
4. **Purchasing**: supplier invoice draft→post (stock receive at line cost + lots,
   GL P-09), PI numbering, payments + allocations to open purchases, AP exposure;
   supplier advances for overpayment.
5. **Cash & expenses**: treasury accounts with GL-derived balances, expense
   pending→approve(posts P-23)/reject flows; pending card settlements listing.
6. **UI (Arabic RTL, both themes, keyboard-first)**: `/pos` (search-first cart, qty
   steppers, price edit w/ boundary hint + override reason, free-goods toggle, discount,
   cash/credit walk-in/named, multi-method tendered with remainder, **save dialog with
   «حفظ وترحيل» / «حفظ مسودة»** and permission-aware blocking hint, clientOpId per cart,
   Ctrl+Enter); `/sales` (customer exposure/advance cards, receipts form w/ allocation
   + advance, drafts post/delete, invoices w/ inline return capture issuing credit
   notes, pending card settlements); `/purchasing` (invoice builder w/ batches/expiry,
   open balances, payment form, drafts post); `/cash` (treasury cards, expenses
   w/ approve/reject).

### Commands executed → results

| Command | Result |
|---------|--------|
| `npx drizzle-kit push` + `psql -f src/db/rls.sql` | ✓ 17 new tables, invoice-immutability triggers, RLS on all |
| `npx tsx scripts/seed.ts` | ✓ phase-3 parties/treasury for both tenants |
| `DATABASE_URL=… npx vitest run` | ✓ **61/61** (sales suite: 12 new incl. RL-2; full regression ×3 stable) |
| typegen / lint / tsc / build / build_and_start | ✓ all green; routes +/pos /sales /purchasing /cash |

### Invariant evidence (tests, all executed)

VAT math exact; customer-price wins; boundary block vs override recording; free-goods
cost→expense, no VAT; credit-limit & hold blocks; auto due date; **concurrent dup
submit = 1 invoice/1 journal** (clientOpId + savepoint); allocations ≤ outstanding
under lock; advance apply/insufficient; returns caps + GL balanced + stock back;
drafts = ZERO GL rows until posted, single winner on post race; card pending→settled;
posted invoice/purchase update/delete blocked; purchase cycle; **RL-2: AR control
(1103 journal balance) == Σ customer exposures exactly (2dp)**.

### Incident (fixed, adopted as a rule)

**Advisory↔row-lock deadlock cycle** under concurrent posting tests (write_audit chain
lock taken mid-transaction while row locks held). **Rule adopted — uniform lock order:
`withTenant` acquires the per-tenant advisory lock FIRST (before any row lock).**
Serializes intra-tenant writes per tx (documented trade-off; finer ordered per-entity
locks can replace the gate if contention shows). Re-verified 3× full-suite runs.

### Residuals moved forward

- Purchase returns/PO + 3-way match, landed costs, bank reconciliation UI,
  HR payroll runs & commission calculations, tenant price *lists* UI, printable
  Arabic invoice templates (Phase 6 with tax layouts), statements/aging PDF,
  walk-in card settlement sub-model, rep online flows reuse POS engine via rep scope.
- Expense category → GL mapping is single-level now (expense_default).

### Exact next step (Phase 4)

Representative provisioning (employee→role→**idempotent custody warehouse**, AC-001/002),
device registration, rep transfer dispatch/accept UI, rep PWA shell + offline outbox
(Dexie) + `/api/sync` push/pull with idempotency dedupe, then settlement state machine
(D-022). Start with schema (representatives/devices/egs?) + provisioning service +
AC-001/002 tests.

### Status: Phase 2 complete ✅ (residuals listed, all engine invariants proven)
### Next: Phase 3 — parties, sales/POS, purchasing, cash & banks (roadmap)

### Work completed

1. **Accountants' core**: COA tenant template (28 accounts per ACCOUNTING_POLICY §3),
   posting-mappings resolver (`resolveMappingId`, missing → blocking ConfigurationError,
   INV-17), fiscal years/periods (12 monthly periods/year, close blocked by drafts, reopen
   audited), `PostingService` (`postEntry`/`createDraftManual`/`postDraft`/`reverseEntry`)
   with balanced-check + idempotency unique keys + posting-time numbering (JV series, row
   lock), reversals unique per original.
2. **DB enforcement** (merged into canonical `src/db/rls.sql`, idempotent): RLS on all Phase 2
   tables; triggers — balanced+open-period+entry-number gate on posted journals
   (`assert_journal_postable`), journal & line immutability once posted (INV-03),
   append-only `stock_ledger` (INV-05), `qty_received ≤ qty_dispatched` (INV-07).
3. **Inventory engine** (`StockLedgerService.recordMovement`): row-locked balances
   (`FOR UPDATE`), negative-stock prevention default (per-warehouse override flag),
   WAC per (warehouse,product), FEFO lot allocation w/ per-lot ledger rows, zero-cost
   guard, idempotency = pre-check + savepoint (PG abort-on-error semantics), per-movement
   audit writes. Transfers: draft→dispatch (source→in_transit carrying cost,
   auto-number TR, rep notification hooked)→accept(full/partial/dispute, atomic received≤
   dispatched, replay skips line updates via acceptRef)→received→closed.
4. **Catalog**: units (EA/CTN/KG/LTR), categories, brands, products (SKU/barcode AR/EN
   names, min/max price boundaries, trackLots/expiry flags, tax_category), product_units
   conversion factors (×12 carton demo). Seed: 5 demo SKUs + opening stock 10,030.00 SAR
   **with matching opening GL entry #1** (P-31) — balances verified via psql.
5. **Arabic UI (both themes)**: `/accounting` — journals list with post/reverse
   (confirm+inline results), balanced-check live journal form (draft/save&post), posting
   mappings editor with "غير مضبوط — يمنع الترحيل" blocking banners, periods close/reopen,
   COA tree. `/inventory` — live balances w/ valuation, receipt form (lots/expiry),
   transfers with dispatch + accept-all + close states, products (create form + list),
   warehouses cards. Nav enabled for both.
6. **Seed extended** (`scripts/seed.ts` idempotent): COA+mappings+fiscal 2026+warehouses
   (MAIN/QUAR/INTRANSIT)+catalog+opening for tenant A; foundation-only for tenant B.

### Commands executed → results

| Command | Result |
|---------|--------|
| `npx drizzle-kit push` (×2) | ✓ 22 new tables/enums |
| `psql -f src/db/rls.sql` (consolidated) | ✓ policies+functions+triggers idempotent |
| `npx tsx scripts/seed.ts` | ✓ verified: 66 accts, 54 mappings, 24 periods, 10 products, posted entry #1 |
| `DATABASE_URL=… npx vitest run` | ✓ **49/49** (kernel 21, crypto 6, auth 3, RLS 5, accounting 7, inventory 7) |
| `npx next typegen` / lint / `tsc --noEmit` / `npm run build` | ✓ pass ×4 |
| `build_and_start` + curl checks | ✓ ok:true; `/accounting` & `/inventory` auth-gated 307s |

### Invariant evidence (tests)

- INV-01 balanced at service + DB trigger; INV-02 identical retry = replayed single entry;
  draft double-post race → one posted number; INV-03 update/delete posted blocked at DB;
  INV-04 reversal linked + second reversal rejected; INV-05 ledger append-only at DB;
  INV-05/02 retry storms replay without side effects (pre-check + savepoint);
  INV-06 ledgerVsBalance matches; INV-07 full transfer cycle incl. partial, retry-replay,
  over-receive guard, close; INV-15 last-unit oversell: 1 winner / 1 rejected;
  INV-17 missing mapping blocks; AC-020 closed period blocked at service AND trigger.

### Incidents → adopted rules (important ops lessons)

1. **`drizzle-kit push` dropped existing RLS policies** (it doesn't manage externally
   created policies). **Rule: after EVERY push, re-apply `src/db/rls.sql` (canonical,
   idempotent).** (Candidate later: declare policies via drizzle-kit migrate snapshots.)
2. PG aborts the whole transaction on any error → naive "catch unique then SELECT" breaks;
   **rule: idempotent ops use pre-check + SAVEPOINT (recordMovement/postEntry pattern).**
3. Raw `select *` returns snake_case keys while drizzle returns camelCase — a lockTransfer
   bug shipped from that; **rule: use drizzle `.for("update")` for row locks.**
4. decimal.js `toFixed()` without dp strips trailing zeros — money/avg displays use
   explicit dp (`toFixed(4)`).
5. Test suites creating products must use run-unique SKUs to stay re-runnable.

### Residuals moved forward (explicitly not done)

- Physical count UI & adjustment approval screens → bundled with warehouse ops (Phase 4).
- Nightly ledger↔balance reconcile **job** (query exists via tests) → wired with reporting
  jobs (Phase 7) unless needed earlier.
- Lot/expiry reports & genealogy → Phase 5 (transfers currently bypass per-warehouse lot
  rows by design D-009 note; documented in INVENTORY doc as Phase-2 simplification).
- Price lists/customer prices → Phase 3.
- POS + invoices + receipts → Phase 3.

### Exact next step (Phase 3)

Customers/suppliers + allocation engine → invoice document model (4 status dimensions) +
save dialog (A/B) + ERP POS using customer pricing & free-goods lines → receipts w/
allocations → cashboxes/banks + expenses + e-payment records. Start with parties schema
and the allocation invariant tests (INV-08/09).

### Status: Phase 1 COMPLETE ✅ — next action: Phase 2, task 1 (COA + posting mappings)

### Work completed

1. **Packages**: argon2, pino, pg-boss, zod, decimal.js, uuidv7, next-themes,
   lucide-react, clsx, tailwind-merge, vitest, tsx, @fontsource/ibm-plex-sans-arabic.
   (`npm install` reported 18 vulnerabilities in transitive deps — none reachable from
   app code paths in this phase; tracked for Phase 10 hardening review.)
2. **Shared kernel** `src/modules/shared/`: result/DomainError taxonomy, decimal-only
   money (D-003), uuidv7 ids, tenant business-date helpers, pino logger with redaction,
   permission catalog (`PERMISSIONS` 54 codes + `ROLE_PRESETS` 8 roles), session-context
   guards, tenant-scoped tx helper (`withTenant` binds `app.tenant_id`), audit writer.
3. **DB foundation**: 14 tables (tenants, companies, branches, platform_users, users,
   employees, permissions, roles, role_permissions, user_roles, sessions, audit_log,
   document_counters, notifications) via `drizzle-kit push`; `src/db/rls.sql` applied —
   RLS enabled+FORCED on tenant tables, policies on `app_tenant_id()`, SECURITY DEFINER
   `user_login_lookup` / `platform_login_lookup` / `write_audit` (per-tenant hash chain,
   advisory-locked).
4. **Auth**: Argon2id, server sessions (12 h sliding expiry), httpOnly cookie,
   login/logout server actions with audit events, timing-dummy verify, `getSessionContext`
   (React-cached) building permission set; edge middleware = cookie-presence gate only
   (imports edge-safe `identity/constants.ts` — hard lesson #1 below).
5. **RTL Arabic shell**: tokenized light/dark themes, IBM Plex Sans Arabic, ar/en
   dictionaries (typed), role-filtered sidebar with disabled "قريباً" roadmap items,
   notifications badge, theme toggle, user menu + logout; dashboard reads real tenant data.
6. **Jobs/logging**: pg-boss worker via `instrumentation.ts` (heartbeat queue,
   schedule every 15 min, v12 queue-level retry policy); `/api/health` extended
   (db + worker + pool + latency).
7. **Seeds** (`scripts/seed.ts`, idempotent): permission catalog, platform owner
   `admin@hisab.sa`, tenant A «شركة الأفق للتموين الغذائي» (owner/acc/rep/wh users),
   tenant B «شركة النخبة للتوزيع» (owner) — demo password `Hisab#2026` (sandbox only;
   override via SEED_DEMO_PASSWORD / SEED_BOOTSTRAP_PASSWORD).

### Commands executed → results

| Command | Result |
|---------|--------|
| `npx drizzle-kit push` | ✓ 14 tables + 3 enums created |
| `psql -f src/db/rls.sql` | ✓ RLS + 3 functions + revoke — **idempotent re-runnable** |
| `npx tsx scripts/seed.ts` | ✓ 54 perms, platform owner, 2 tenants, 5 users |
| `DATABASE_URL=… npx vitest run` | ✓ **35/35 passed** (kernel 21, auth-crypto 6, auth-service 3, RLS isolation 5) |
| `npx next typegen` / `npm run lint` / `tsc --noEmit` | ✓ pass / pass / exit 0 |
| `npm run build` | ✓ routes: /, /login, /dashboard, /api/health (+middleware) |
| platform `build_and_start` | 1st attempt FAILED → fixed (see incident) → 2nd ✓ |
| live checks (curl) | health `{"ok":true,"worker":"ready"}`; `/`→307 `/login`; `/dashboard` unauth→307 `/login?next=…`; login HTML `lang="ar" dir="rtl"` |
| `psql` audit verification | seed events hashed & chained; sessions=4; perms=54 |

### Incident (fixed, documented)

`build_and_start` healthcheck 500 — root cause: `middleware.ts` imported
`SESSION_COOKIE` from `identity/auth.ts` (node:crypto/argon2/pg) → edge bundle crash
("Unsupported external type ... node:crypto"). Fix: edge-safe `identity/constants.ts`;
middleware imports only that. **Rule adopted:** middleware may import only edge-safe
modules; enforced by build/start hereafter.

### Security/concurrency evidence

- RLS role `hisab_rls_test` (NOBYPASSRLS): zero visibility w/o context; single-tenant
  visibility with context; **cross-tenant UPDATE = 0 rows**; **cross-tenant INSERT
  rejected** by WITH CHECK; audit insert via `write_audit` + hash-chain linkage verified.
- Session lifecycle: create→resolve→revoke→dead; expired rejected (integration tests).
- Timing countermeasure: dummy argon2 verify on unknown email.

### Known limitations (honest list)

- Browser click-through of the login form not yet automated (Playwright suite is a
  later-phase task); credential round-trip proven at service layer instead.
- Suspended-tenant read-only mode: login blocked; console read-only policy arrives in
  Phase 8 (documented).
- Sessions: refresh/idle policy enforced by expiry+touch; concurrent-session caps not
  implemented (post-v1 note).
- npm audit advisories open (transitive), not remediated in this phase.

### Exact next step (Phase 2)

COA template + posting-mappings configuration with blocking errors → fiscal periods →
`journal_entries/lines` + PostingService with balanced-check & idempotency unique keys →
invariant tests (balanced entries, no-post-to-closed-period). See ROADMAP Phase 2 tasks 1–3.

## Session 1 — 2026-10-15 · Phase 0 (repository assessment + documentation)

### Status: Phase 0 COMPLETE ✅ — next action: Phase 1, task 1 (app structure + shared kernel)

### Repository assessment (evidence-based)

- Working tree inspected: starter template only. Files: `next.config.ts`,
  `drizzle.config.json`, `tsconfig.json`, `postcss.config.mjs`, `eslint.config.mjs`,
  `.env`, `src/db/index.ts` (node-postgres Pool + drizzle client), `src/db/schema.ts`
  (empty placeholder), `src/app/{layout.tsx,page.tsx,globals.css}`,
  `src/app/api/health/route.ts`.
- Toolchain: Node v22.23.2, npm 10.9.8, `node_modules` present. Next.js 16.2.6
  (Turbopack), React 19.2.6, drizzle-orm 0.45.2, drizzle-kit 0.31.10, Tailwind v4.1.17,
  TypeScript 5.9.3.
- Git: clean working tree at assessment time.
- **Reusable as-is**: db pool/client, health route, drizzle config, Tailwind wiring.
- **Replaced later**: root layout `lang="en"` (→ `ar`/RTL in Phase 1), placeholder page.
- **Database posture**: empty sandbox DB (`postgresql://postgres:postgres@127.0.0.1:5432/app_db`),
  no migrations, no user data → safe to evolve schema freely in this environment.
  No destructive operation was performed or needed.
- **No prior functionality existed to preserve.** Nothing was rewritten that contained
  user work.

### Work completed (docs only — zero application code changed)

- Created root `docs/` package (19 files): README, PRODUCT_REQUIREMENTS, DOMAIN_MODEL,
  SYSTEM_ARCHITECTURE, ACCOUNTING_POLICY, INVENTORY_AND_COSTING, VAN_SALES_WORKFLOW,
  INVOICING_AND_ZATCA, SECURITY_AND_TENANCY, OFFLINE_SYNC, REPORTING_SPECIFICATION,
  AI_ASSISTANT, BACKUP_AND_RECOVERY, PLATFORM_ADMIN, UX_AND_DESIGN_SYSTEM,
  TESTING_AND_ACCEPTANCE, IMPLEMENTATION_ROADMAP, DECISIONS, PROGRESS (this file).
- Cross-consistency review performed: decision IDs (D-001…D-026), invariants
  (INV-01…17), acceptance IDs (AC-001…036), posting rules (P-01…P-32), report IDs
  (R-01…R-66) referenced consistently across docs.
- Open business/legal questions registered — **must not be silently answered in code**:
  OQ-1…OQ-11 in `DECISIONS.md` (most critical: OQ-2/OQ-3 offline tax legality, OQ-4 free
  goods VAT, OQ-5 payroll deduction legality, OQ-9 offline limits).

### Commands actually executed (with real results)

| Command | Result |
|---------|--------|
| `node --version && npm --version` + checks | v22.23.2 / 10.9.8; node_modules present; git tree clean |
| `npx next typegen` | ✓ "Types generated successfully" |
| `npm exec tsc -- --noEmit --pretty false` | ✓ exit 0 (0 errors) |
| `npm run build` | ✓ Next 16.2.6 production build; routes `/`, `/_not-found`, `/api/health` |
| `date -u` | 2026-10-15 06:12 UTC |
| doc consistency check (broken-link scan + ID cross-references) | ✓ no broken links; D-/INV-/AC-/OQ- IDs consistent across files (1,989 doc lines) |
| Final gate: `npx next typegen` / `tsc --noEmit` / `npm run build` | ✓ all pass (rerun after docs; exit 0) |
| platform `build_and_start` | ✓ success — DB bootstrapped, production build+start, `/api/health` verified; preview URL issued (build ≈ 6.5 s) |

### Tests

- None exist yet (no test framework installed). Test strategy defined in
  TESTING_AND_ACCEPTANCE.md; Vitest/Playwright setup is a Phase 1 task.
- No claim is made about any AC-### scenario: none have run.

### Migrations / data

- No migrations exist; `drizzle.config.json` points at empty schema. No data changed
  this session.

### Unresolved defects / known gaps

- None in code (no feature code exists). Docs-level gaps intentionally OPEN: all OQ-*
  items; ZATCA endpoint/spec details must come from official documentation at Phase 6
  (D-012 — nothing was invented); offline default limits in OFFLINE_SYNC §6 are
  provisional pending OQ-9.

### Exact next step (Phase 1, in dependency order)

1. Install foundation deps (`argon2`, `pino`, `pg-boss`, `zod`, `decimal.js`, `ulid`/uuidv7 helper, `next-themes`, vitest toolchain).
2. Create `src/modules/shared` kernel (Result/DomainError, Money, dates, ids, audit, tx) and `src/db/schema.ts` foundation tables (tenancy/identity/audit/counters) per DOMAIN_MODEL §2.1 + first `drizzle-kit push`.
3. RTL Arabic layout shell + fonts + theme tokens + locale dictionaries; replace `lang="en"`.
4. Session auth + login; RBAC guard; RLS policies; audit log writes.
5. Bootstrap seeds (Platform Owner, demo tenant + Tenant Owner) — sandbox only.
6. Health endpoint extension (queue/backup/sync placeholders wired by Phase 1 end).

### Resume checklist for next session

1. Read docs/README.md, PROGRESS.md (this), IMPLEMENTATION_ROADMAP.md, DECISIONS.md.
2. `git status` / file listing — confirm no unexpected changes since this entry.
3. Run the validation gate once to confirm baseline: typegen, tsc, build.
4. Start Phase 1 task 1 above. Do NOT re-create docs unless a decision changed.
