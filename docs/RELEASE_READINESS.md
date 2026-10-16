# Release-readiness report — Phase 10

**Date:** 2026-10-16 · **Branch:** `arena/60f797f0-erpcloud3` · **Scope:** the whole product
(Phases 0–9 implemented; Phase 10 = UX completion, hardening & release readiness).

**Verdict: not production-ready — and deliberately not claimed as such.** The build is
code-complete for every phase whose exit criteria could be executed in this environment, all
gates below are green, and the operational documentation exists. What is *missing* is not polish
but environmental and process capability: versioned migrations, off-site backup transport, a real
ZATCA credential cycle, browser-driven E2E/accessibility coverage, deployment automation, and the
open legal questions. Each is listed in §5 with what would close it.

Recommended use **today**: internal demo / UAT on a controlled environment (single node, demo
data, no real KSA e-invoicing traffic). Recommended use **not** allowed yet: production invoicing
to ZATCA, or any multi-tenant hosting of real customer books.

---

## 1. Gates executed (evidence, not intentions)

| Gate | Command | Result |
|---|---|---|
| Types | `npm run typecheck` | ✅ exit 0, 0 errors |
| Test suite | `set -a && . ./.env && set +a && npm test` | ✅ **21 files / 184 passed / 8 skipped / 0 failed** |
| Production build | `npm run build` | ✅ "Compiled successfully in 13.2s", all routes emitted |
| End-to-end HTTP sweep | `npm run acceptance:sweep -- --soak=20` | ✅ **ACCEPTANCE SWEEP PASSED — 39/39 checks** |
| Backup + verification | `npm run backup:run && npm run backup:verify` | ✅ `status verified`, 6/6 checks |
| Restore drill | `npm run backup:drill` | ✅ `status passed`, 7/7 invariants, RTO ≈ 1.6 s |
| Assistant retention (dry run) | `npm run ai:retention -- --dry-run` | ✅ reports tenant, window 30 d, cutoff, 0 conversations, tickets retained 1 |
| Live UI smoke | minted session + `curl` | ✅ `/assistant`, `/assistant/settings` 200 with RTL shell and all Arabic markers |

The 8 skipped tests are role-switching assertions that the sandbox engine (single backend session)
cannot serve; they are skipped with a documented reason and are **never reported as passing**
(`docs/TESTING_AND_ACCEPTANCE.md` §2).

## 2. What the acceptance sweep proves (39 checks)

| Group | Checks | What it establishes |
|---|---|---|
| Public | 3 | `/login` and `/platform/login` render (RTL shell, no framework error page); `/api/health` answers JSON |
| Tenant screens | 18 | `/dashboard`, `/accounting`, `/inventory`, `/sales`, `/purchasing`, `/cash`, `/pos`, `/manufacturing`, `/settlement`, `/tax`, `/reports`, `/assistant`, `/assistant/settings` and the five van-sales screens all render with a tenant session |
| Console screens | 9 | `/platform` dashboard, tenants, plans, flags, alerts, backups, exports, audit and one tenant detail page render with a platform session |
| Session-namespace isolation | 7 | a **tenant** cookie cannot open `/platform*` (307) and a **platform** cookie cannot open `/dashboard`, `/assistant`, `/reports` (307); anonymous cannot open `/assistant` |
| Soak smoke | 2 | 20 warm sequential hits over `/dashboard`, `/reports`, `/assistant`: 0 failures, mean 315 ms / p50 195 ms / p95 622 ms |

> **Scope of that last row:** it is a *smoke*, not capacity evidence. It ran against the dev server
> (Turbopack) on a database engine that serializes every logical connection. No load, soak,
> concurrency or failover claim is made for a production deployment.

## 3. Backup / restore evidence (fresh, this session)

```
npm run backup:run     → 81 tables / 6737 rows · plaintext sha256 a34f37d2… · artifact sha256 cd07baed…
                         .backups/hisab-2026-10-16T00-25-51-742Z-01a14219.enc (6,375,179 bytes) · 855 ms
                         remote provider local-contract · remote verified true
npm run backup:verify  → status verified · artifact_present ✓ artifact_checksum ✓ decrypt ✓
                         plaintext_checksum ✓ content (81 tables/6737 rows) ✓ referential_integrity (149 FKs) ✓
npm run backup:drill   → status passed · row_counts ✓ journal_balance (351 posted entries) ✓
                         tenant_partitioning (68 tenant-owned tables) ✓ row_sampling 15/15 ✓
                         audit_integrity (1353 audit rows) ✓ referential_integrity ✓
                         isolation: schema restore_drill_mva88f67, 227 policies untouched · RTO ≈ 1.6 s
```

Recorded limits (unchanged, and not papered over): the `pg_dump --format=custom` path cannot run
here (no client binaries), so `backup_runs.format = logical-json`; remote transport is the explicit
`local-contract` — **it is not Google Drive and is not off-site storage**.

## 4. Phase 10 item-by-item status

| Phase 10 item | Status | Evidence / what is left |
|---|---|---|
| RTL & bilingual sweep | **Partial** | Dictionaries are type-locked (`en` must match the `ar` shape, so a missing translation is a compile error); every new screen was verified in Arabic. A screen-by-screen visual RTL audit (numbers, dates, icon direction, print templates) has **not** been performed. |
| Accessibility audit (AA) | **Partial** | Assistant screens now expose `role="log"` + `aria-live="polite"` + `aria-busy`, `role="status"`/`role="alert"` banners and labelled inputs; the acceptance sweep asserts the RTL shell renders. Contrast ratios, focus order, keyboard traps and screen-reader passes across all ~40 screens are **not** audited. |
| Status-semantics audit (never colour-only) | **Partial** | Status text is present in the assistant screens and console cards; a systematic colour-independence check across every status badge is **outstanding**. |
| Load / soak smoke | **Smoke only** | §2 soak row. No capacity claim. |
| Security review (authZ matrix re-verified) | **Partial (automated)** | New structural suite `tests/unit/ui-guards.test.ts` (11 assertions): every page is behind a session/platform guard (page or its layouts), console pages resolve a platform context, the console has exactly one layout door, every permission named at a guard site exists in the right catalogue, navigation uses real tenant codes only, the ops role holds no destructive code, unknown roles get an empty set, and only four named non-platform files may import platform services. Behavioural coverage continues in the integration suites (tenant isolation, authZ matrix, platform ops). No third-party penetration test is possible in this environment. |
| Backup restore re-drill | **Done** | §3. |
| Full E2E acceptance run (AC list) | **Partial** | Automated: the 39-check HTTP sweep + 21 test files. **Not** executable here: printed-document checks, offline rep device behaviour, real ZATCA round-trip, browser-driven UI flows (no Playwright in this build). |
| Deployment & rollback runbook | **Done (untested on a real host)** | `docs/RUNBOOK.md` §2–§3. |
| Operational runbooks | **Done** | `docs/RUNBOOK.md` §4–§5 (routine jobs, alert semantics, six incident playbooks) + `docs/OPERATIONS_GUIDE.md` (Arabic, user-facing). |
| Release-readiness report | **Done** | this file. |
| OQ staffing/legal inputs | **Still open** | OQ-2/OQ-3/OQ-4 remain OPEN by decision; nothing was resolved silently in code. |

## 5. Blockers for a production go-live (ranked)

1. **No versioned migrations.** The schema is applied with `drizzle-kit push`; a production
   upgrade path needs reviewed migrations and a rollback story that does not depend on restore.
   *Closes with:* adopting a migration tool and replaying the current schema as baseline.
2. **No off-site backups.** The remote transport is a local contract. *Closes with:* a real
   provider (e.g. Drive) plus credential handling and a restore test from that provider.
3. **ZATCA production cycle never executed** (AC-025). Structure, signature and validation are
   covered against the official SDK rules; the compliance→pCSID cycle and real
   clearance/reporting were not run because no sandbox credentials may be invented. *Closes with:*
   one full cycle on Simulation with real credentials, then a signed-off production run.
4. **No legal sign-off** (OQ-2/3/4). Retention, e-invoicing obligations and data-residency choices
   are recorded as questions, not answers.
5. **No browser-driven E2E / accessibility audit.** Nothing verifies visual behaviour, printing or
   keyboard navigation automatically. *Closes with:* Playwright (or equivalent) plus a manual AA
   pass.
6. **No deployment automation / observability integration.** No containers, IaC, CI pipeline,
   external paging, or metrics/monitoring endpoint beyond `/api/health` and the console.
7. **Known functional gaps** (documented, not defects): PDF export, R-05/R-10/R-12/R-24/R-27 and
   R-46…R-51 report sources, assistant streaming and document ingestion, cost/billing metering.

## 6. Defects found during Phase 10 (and their fate)

| # | Finding | Where | Fate |
|---|---|---|---|
| 1 | The seven new platform dictionary keys for the AI-usage card were never written (the patch asserted on a wrong anchor) while the page already used them | `src/i18n/{ar,en}.ts` | fixed before commit; `tsc` went red→green; recorded in PROGRESS Session 12 |
| 2 | Screen props were declared in two interfaces (label bag **and** component props) | `assistant-screen.tsx` | de-duplicated: the label bag owns wording, the component owns data |
| 3 | A read-only tenant would have been reported as "0 conversations expired" by the retention sweep | `modules/ai/retention.ts` | now skipped *before* the sweep with `skippedReason: errors.tenantReadOnly` |
| 4 | The first acceptance sweep script failed itself: it minted a tenant session without `sessions.tenant_id` (every screen 307'd), and its error detector matched Next's embedded 404-template text inside the RSC payload | `scripts/acceptance-sweep.mts` | both fixed; the sweep now passes 39/39 and a failed request is reported as a check, never thrown |
| 5 | (environmental, not a defect) one sweep run stalled for minutes on a single route and the dev server was reaped mid-run | dev engine under sustained sequential load | re-run clean; soak numbers are reported as smoke only |

No defect was closed by weakening a test or by loosening a validator.

## 7. Sign-off

| Role | Name | Decision | Date |
|---|---|---|---|
| Build owner | (agent session) | *code-complete; gates green; not production-ready per §5* | 2026-10-16 |
| Product owner | — | pending | |
| Security reviewer | — | pending | |
| Tax/legal (ZATCA) | — | pending (OQ-2/3/4) | |
