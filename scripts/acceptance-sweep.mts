/**
 * Phase 10 — end-to-end acceptance sweep over HTTP (release-readiness evidence).
 *
 * What it does, in order:
 *
 *   1. mints two *test* sessions directly in `sessions` — one tenant-owner session and
 *      one platform session — and **revokes both at the end** (this is a probe, not a
 *      login bypass: it inserts the same row a successful login would, then deletes it);
 *   2. walks every route of the app with the correct cookie and asserts it renders —
 *      HTTP 200, the RTL shell present, and no framework error page;
 *   3. proves the two session namespaces stay separate: the tenant cookie must not open
 *      a console page, the platform cookie must not open a tenant screen;
 *   4. optional soak (`--soak=N`): repeats the read-heavy screens and reports latency
 *      percentiles, so "release ready" is not claimed on a cold-cache single request.
 *
 * Usage (dev server must be running):
 *   npx tsx scripts/acceptance-sweep.mts [--soak=40] [--base=http://127.0.0.1:3000]
 *
 * Exit code 0 = every assertion held; 1 = at least one route or isolation check failed.
 */

import { createHash, randomUUID } from "node:crypto";
import { Client } from "pg";

const arg = (name: string, fallback: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1] ?? fallback;

const BASE = arg("base", process.env.ACCEPTANCE_BASE ?? "http://127.0.0.1:3000");
const SOAK = Number(arg("soak", "0"));

/** Tenant screens, with a marker that must appear in the rendered HTML. */
const TENANT_ROUTES: [string, string | null][] = [
  ["/dashboard", null],
  ["/accounting", null],
  ["/inventory", null],
  ["/sales", null],
  ["/purchasing", null],
  ["/cash", null],
  ["/pos", null],
  ["/manufacturing", null],
  ["/settlement", null],
  ["/tax", null],
  ["/reports", null],
  ["/assistant", "المساعد الذكي"],
  ["/assistant/settings", "متغير بيئة المفتاح"],
  ["/rep", null],
  ["/rep/pos", null],
  ["/rep/settle", null],
  ["/rep/transfers", null],
  ["/rep/sync", null],
];

/** Console screens (platform session). */
const PLATFORM_ROUTES: [string, string | null][] = [
  ["/platform", "لوحة المنصة"],
  ["/platform/tenants", null],
  ["/platform/plans", null],
  ["/platform/flags", null],
  ["/platform/alerts", null],
  ["/platform/backups", null],
  ["/platform/exports", null],
  ["/platform/audit", null],
];

const PUBLIC_ROUTES: [string, string | null][] = [
  ["/login", "تسجيل الدخول"],
  ["/platform/login", null],
  ["/api/health", null],
];

interface Check {
  check: string;
  detail: string;
  ok: boolean;
}

const checks: Check[] = [];
const record = (check: string, ok: boolean, detail: string) => {
  checks.push({ check, ok, detail });
  console.log(`${ok ? "✓" : "✗"} ${check.padEnd(46)} ${detail}`);
};

const token = () => `acceptance-${randomUUID()}`;
const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

const db = new Client({ connectionString: process.env.DATABASE_URL! });
await db.connect();

const tenantUser = (
  await db.query(`select u.id, u.tenant_id from users u join tenants t on t.id = u.tenant_id
                  where t.status in ('trial','active') order by u.created_at limit 1`)
).rows[0];
const platformUser = (
  await db.query(`select id from platform_users where status = 'active' order by created_at limit 1`)
).rows[0];
const tenantId = (
  await db.query(`select id from tenants order by created_at limit 1`)
).rows[0]?.id as string | undefined;

if (!tenantUser || !platformUser || !tenantId) {
  console.error("no tenant/platform user to probe with — run `node scripts/db-reset.mjs && npx tsx scripts/seed.ts`");
  process.exit(1);
}

const tenantToken = token();
const platformToken = token();
const sessionIds: string[] = [];

/**
 * Insert the row a successful login would have inserted. A tenant session carries its
 * tenant (`sessions.tenant_id`); a platform session must NOT (`buildContextByToken`
 * refuses a row that has both, which is the session-isolation rule itself).
 */
const mint = async (
  columns: { user_id?: string; platform_user_id?: string; tenant_id?: string },
  raw: string,
) => {
  const id = randomUUID();
  await db.query(
    `insert into sessions (id, user_id, platform_user_id, tenant_id, token_hash, expires_at, created_at)
     values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, now() + interval '20 minutes', now())`,
    [id, columns.user_id ?? null, columns.platform_user_id ?? null, columns.tenant_id ?? null, sha256(raw)],
  );
  sessionIds.push(id);
};

await mint({ user_id: tenantUser.id, tenant_id: tenantUser.tenant_id }, tenantToken);
await mint({ platform_user_id: platformUser.id }, platformToken);

/**
 * One request, never a thrown exception: a dead socket must be *reported* as a failed
 * check (with its reason), not abort a sweep that has already produced evidence.
 */
const get = async (route: string, cookie?: string) => {
  const started = Date.now();
  try {
    const response = await fetch(`${BASE}${route}`, {
      headers: cookie ? { cookie } : {},
      redirect: "manual",
      signal: AbortSignal.timeout(90_000),
    });
    const body = await response.text();
    return { status: response.status, body, ms: Date.now() - started, error: null as string | null };
  } catch (e) {
    return {
      status: 0,
      body: "",
      ms: Date.now() - started,
      error: (e as { cause?: { code?: string }; code?: string; name?: string }).cause?.code ??
        (e as { code?: string }).code ??
        (e as Error).name,
    };
  }
};

const shellOk = (body: string) => body.includes('dir="rtl"');
/**
 * Next always embeds its 404 template text inside the RSC flight payload, so a text
 * search for "could not be found" would fail a perfectly healthy page. `__next_error__`
 * is the id of the *rendered* error document — that is the real signal.
 */
const errorPage = (body: string) => /id="__next_error__"|Application error: a [a-z-]+-side exception/.test(body);

/**
 * NOTE on the latency column: this runs against the **dev** server (Turbopack compiles
 * a route on its first request) on a database whose engine serves every logical
 * connection from a single backend session. Treat the numbers as a smoke test that the
 * screens respond, never as capacity evidence.
 */
const sweep = async (label: string, routes: [string, string | null][], cookie?: string) => {
  console.log(`\n── ${label} ─────────────────────────────────────────────`);
  for (const [route, marker] of routes) {
    const res = await get(route, cookie);
    const problems: string[] = [];
    if (res.error) problems.push(`request failed: ${res.error}`);
    else if (res.status !== 200) problems.push(`HTTP ${res.status}`);
    if (res.status === 200 && errorPage(res.body)) problems.push("framework error page");
    if (res.status === 200 && !errorPage(res.body)) {
      // API routes answer JSON by design; every rendered screen must carry the RTL shell.
      if (route.startsWith("/api/")) {
        if (!res.body.trimStart().startsWith("{")) problems.push("not a JSON body");
      } else if (!shellOk(res.body)) {
        problems.push("no RTL shell");
      }
    }
    if (marker && !res.body.includes(marker)) problems.push(`missing marker “${marker}”`);
    record(`${label} ${route}`, problems.length === 0, problems.join(", ") || `200 · ${res.ms} ms`);
  }
};

const soak = async () => {
  if (SOAK <= 0) return;
  console.log(`\n── soak: ${SOAK} sequential hits over 3 read-heavy screens ───`);
  const targets = ["/dashboard", "/reports", "/assistant"];
  // Warm-up first: the dev server compiles a route on its first request, and measuring
  // that would report Turbopack's compiler time as if it were application latency.
  for (const route of targets) await get(route, `hisab_session=${tenantToken}`);
  const samples: number[] = [];
  let failures = 0;
  for (let i = 0; i < SOAK; i++) {
    const route = targets[i % targets.length]!;
    const res = await get(route, `hisab_session=${tenantToken}`);
    samples.push(res.ms);
    if (res.status !== 200) failures++;
  }
  samples.sort((a, b) => a - b);
  const at = (p: number) => samples[Math.min(samples.length - 1, Math.floor(samples.length * p))]!;
  const total = samples.reduce((a, b) => a + b, 0);
  record(
    "soak: no failed request",
    failures === 0,
    `${samples.length} requests, ${failures} failures`,
  );
  record(
    "soak: latency",
    true,
    `mean ${Math.round(total / samples.length)} ms · p50 ${at(0.5)} ms · p95 ${at(0.95)} ms · max ${samples.at(-1)} ms`,
  );
};

try {
  await sweep("public", PUBLIC_ROUTES);
  await sweep("tenant", TENANT_ROUTES, `hisab_session=${tenantToken}`);
  await sweep("platform", [...PLATFORM_ROUTES, [`/platform/tenants/${tenantId}`, null]] as [string, string | null][], `hisab_platform_session=${platformToken}`);

  console.log("\n── session-namespace isolation ─────────────────────────");
  for (const route of ["/platform", "/platform/tenants", "/platform/backups"]) {
    const res = await get(route, `hisab_session=${tenantToken}`);
    record(
      `tenant cookie cannot open ${route}`,
      res.status !== 200,
      `HTTP ${res.status} (must not be 200)`,
    );
  }
  for (const route of ["/dashboard", "/assistant", "/reports"]) {
    const res = await get(route, `hisab_platform_session=${platformToken}`);
    record(
      `platform cookie cannot open ${route}`,
      res.status !== 200,
      `HTTP ${res.status} (must not be 200)`,
    );
  }
  const anon = await get("/assistant");
  record(`anonymous cannot open /assistant`, anon.status !== 200, `HTTP ${anon.status} (must not be 200)`);

  await soak();
} finally {
  await db.query(`delete from sessions where id = any($1::uuid[])`, [sessionIds]);
  await db.end();
}

const failed = checks.filter((c) => !c.ok);
if (failed.length > 0 && checks.some((c) => c.detail.includes("ECONNREFUSED"))) {
  console.error(
    "\nnote: the dev server stopped answering mid-run (this sandbox reaps long-lived dev\n" +
      "      processes under sustained load). Restart it and re-run; the route checks that\n" +
      "      printed before the failures already passed.",
  );
}
console.log(
  `\n${failed.length === 0 ? "ACCEPTANCE SWEEP PASSED" : "ACCEPTANCE SWEEP FAILED"} — ${checks.length - failed.length}/${checks.length} checks`,
);
if (failed.length > 0) {
  for (const f of failed) console.error(`  ✗ ${f.check}: ${f.detail}`);
  process.exit(1);
}
