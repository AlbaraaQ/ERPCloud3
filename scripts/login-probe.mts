/**
 * Login round-trip probe — the regression guard for the preview-login defect.
 *
 * THE BUG THIS LOCKS DOWN. In the hosted preview the browser loads the app from
 * `https://<port>-<sandbox>.e2b.app` while the proxy forwards to the app with the upstream
 * `host`/`x-forwarded-host`. Next.js refuses a Server Action whose `Origin` does not match the
 * forwarded host ("Invalid Server Actions request.") unless the public origin is allow-listed,
 * so **every form in the app 500'd in the preview** — login first — while working perfectly on
 * localhost. `next.config.ts` now allow-lists the preview host (overridable with
 * `HISAB_ALLOWED_ORIGINS`), and this probe is what proves it, in the reporter's conditions.
 *
 * HOW IT SUBMITS. It does not hand-roll an action payload: it uses React's own `encodeReply`
 * from Next's bundled client (`react-server-dom-turbopack/client.node.js`) and posts it with
 * the `next-action` header, exactly as the browser runtime does. A hand-built multipart body
 * is rejected by the decoder ("formData.get is not a function") — that mistake is why this
 * file uses the real encoder rather than curl-style form fields.
 *
 * Checks, in order:
 *   1. `/login` renders the form and exposes the action id;
 *   2. **login from the preview origin succeeds** → HTTP 303 to `/dashboard` + `hisab_session`;
 *   3. the returned cookie actually opens `/dashboard` (200);
 *   4. a wrong password is a *friendly* result (no 500, no cookie);
 *   5. a foreign origin is still refused (the allow-list is not "allow everything");
 *   6. anonymous `/assistant` is still redirected (the cookie is what grants access);
 *   7. the platform console login path answers (its action transport works too).
 *
 * Usage:  npm run login:probe [-- --base=… --origin=https://3000-xyz.e2b.app]
 * Exit 0 = login works from a proxied/preview origin; 1 = it does not.
 */

import { createHmac } from "node:crypto";
import { Client } from "pg";

const arg = (name: string, fallback: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1] ?? fallback;

const BASE = arg("base", process.env.ACCEPTANCE_BASE ?? "http://127.0.0.1:3000");
const PREVIEW_ORIGIN = arg("origin", "https://3000-preview.e2b.app");
const FORGED_ORIGIN = "https://evil.example.com";
/** What the sandbox proxy sends upstream (the app's own address), in both shapes. */
const UPSTREAM_HOST = new URL(BASE).host;

const { encodeReply } = (await import(
  "next/dist/compiled/react-server-dom-turbopack/client.node.js"
)) as unknown as { encodeReply: (value: unknown) => Promise<FormData> };

const db = new Client({ connectionString: process.env.DATABASE_URL! });
await db.connect();
const [{ email }] = (
  await db.query(`select email from users where email like 'owner@%' order by created_at limit 1`)
).rows as { email: string }[];
const password = process.env.SEED_DEMO_PASSWORD ?? "";
if (!email || !password) {
  console.error("no seeded owner or SEED_DEMO_PASSWORD — run `npm run db:seed`");
  await db.end();
  process.exit(1);
}

interface Check {
  label: string;
  ok: boolean;
  detail: string;
}
const checks: Check[] = [];
const record = (label: string, ok: boolean, detail: string) => {
  checks.push({ label, ok, detail });
  console.log(`${ok ? "✓" : "✗"} ${label.padEnd(56)} ${detail}`);
};

/** The action id React embeds in the form it renders (a cookie may be required to see it). */
async function actionIdOf(pathname: string, origin: string, cookie?: string): Promise<string | null> {
  const html = await (
    await fetch(`${BASE}${pathname}`, { headers: { origin, ...(cookie ? { cookie } : {}) } })
  ).text();
  for (const tag of html.matchAll(/<input\b[^>]*>/g)) {
    const name = /name="(\$ACTION_[^"]*)"/.exec(tag[0])?.[1];
    const value = /value="([^"]*)"/.exec(tag[0])?.[1];
    if (name?.endsWith(":0") && value) {
      try {
        return (JSON.parse(value.replace(/&quot;/g, '"')) as { id: string }).id;
      } catch {
        /* keep looking */
      }
    }
  }
  return null;
}

/** Submit an action the way the browser does: RSC-encoded reply + `next-action`. */
async function submitAction(
  pathname: string,
  actionId: string,
  args: unknown[],
  headers: Record<string, string>,
) {
  const body = await encodeReply(args);
  const response = await fetch(`${BASE}${pathname}`, {
    method: "POST",
    headers: {
      "next-action": actionId,
      accept: "text/x-component",
      ...headers,
    },
    body: body as unknown as BodyInit,
    redirect: "manual",
  });
  const text = await response.text();
  return { status: response.status, text, cookies: response.headers.getSetCookie() };
}

/** The two fields the form carries. */
const formPayload = (mail: string, pass: string) => {
  const data = new FormData();
  data.append("email", mail);
  data.append("password", pass);
  return data;
};

const loginCheck = await fetch(`${BASE}/login`, { headers: { origin: PREVIEW_ORIGIN } });
const loginHtml = await loginCheck.text();
record(
  "GET /login renders the form",
  loginCheck.status === 200 && loginHtml.includes("<form"),
  `HTTP ${loginCheck.status}`,
);

const actionId = await actionIdOf("/login", PREVIEW_ORIGIN);
record("form exposes a server action", Boolean(actionId), actionId ? `id ${actionId.slice(0, 12)}…` : "none found");
if (!actionId) {
  await db.end();
  process.exit(1);
}

const previewHeaders = { origin: PREVIEW_ORIGIN, "x-forwarded-host": UPSTREAM_HOST };
const good = await submitAction("/login", actionId, [{}, formPayload(email, password)], previewHeaders);
// the RSC payload carries the action's *return value*; a redirect means the runtime returned 303
const sessionCookie = good.cookies.find((c) => c.startsWith("hisab_session="));
record(
  "login from the preview origin is accepted",
  !good.text.includes("Invalid Server Actions request"),
  good.text.includes("Invalid Server Actions request")
    ? "the Server Action origin allow-list is missing this host"
    : `HTTP ${good.status}`,
);
record(
  "login returns a session cookie and moves to the dashboard",
  Boolean(sessionCookie) && (good.status === 303 || good.status === 200),
  `${sessionCookie ? "hisab_session set" : "no session cookie"} · HTTP ${good.status}`,
);

if (sessionCookie) {
  const cookie = sessionCookie.split(";")[0]!;
  const dashboard = await fetch(`${BASE}/dashboard`, { headers: { cookie, origin: PREVIEW_ORIGIN }, redirect: "manual" });
  record("the session cookie opens /dashboard", dashboard.status === 200, `HTTP ${dashboard.status}`);
  const console_ = await fetch(`${BASE}/platform`, { headers: { cookie, origin: PREVIEW_ORIGIN }, redirect: "manual" });
  record("a tenant session does not open the console", console_.status !== 200, `/platform HTTP ${console_.status}`);
}

const anonymous = await fetch(`${BASE}/assistant`, { headers: { origin: PREVIEW_ORIGIN }, redirect: "manual" });
record("anonymous is still redirected away from /assistant", anonymous.status !== 200, `HTTP ${anonymous.status}`);

const wrongPassword = await submitAction(
  "/login",
  actionId,
  [{}, formPayload(email, `${password}-wrong`)],
  previewHeaders,
);
record(
  "a bad password is answered with the form, not a 500",
  wrongPassword.status !== 500 &&
    !wrongPassword.cookies.some((c) => c.startsWith("hisab_session=")),
  `HTTP ${wrongPassword.status}, no session issued`,
);

const forged = await submitAction(
  "/login",
  actionId,
  [{}, formPayload(email, password)],
  { origin: FORGED_ORIGIN, "x-forwarded-host": UPSTREAM_HOST },
);
record(
  "a foreign origin is still refused",
  forged.text.includes("Invalid Server Actions request") &&
    !forged.cookies.some((c) => c.startsWith("hisab_session=")),
  forged.text.includes("Invalid Server Actions request") ? "rejected (expected)" : `NOT rejected — HTTP ${forged.status}`,
);

// ── 8. the console's first run: enrollment, then a session ────────────────────────────────
// TOTP is mandatory for the Platform Owner, so a fresh installation can only be entered through
// the enrollment screen. This walks that path end to end — but on a **temporary probe account**,
// never on the real owner: a probe that silently enrolled (or throttled) a real operator would
// be a worse bug than the one it is testing. The account is deleted again below.
//
// A 6-digit code is computed with the same algorithm every authenticator app uses
// (RFC 6238, SHA-1, 30-second step) — no library, no shortcut.
function totp(secretBase32: string, at = Date.now()): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = secretBase32.replace(/=+$/, "").toUpperCase();
  let bits = "";
  for (const char of clean) bits += alphabet.indexOf(char).toString(2).padStart(5, "0");
  const key = Buffer.from((bits.match(/.{8}/g) ?? []).map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 1000 / 30)));
  const digest = createHmac("sha1", key).update(counter).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const value =
    ((digest[offset]! & 0x7f) << 24) | (digest[offset + 1]! << 16) | (digest[offset + 2]! << 8) | digest[offset + 3]!;
  return String(value % 1_000_000).padStart(6, "0");
}

const { hashPassword } = await import("@/modules/identity/auth");
/**
 * One reusable probe account, reset on every run to "active owner, not enrolled".
 *
 * It is **not deleted afterwards on purpose**: `platform_audit_log` is append-only and carries a
 * foreign key to `platform_users`, so removing an operator that ever signed in is refused by the
 * database (SQLSTATE 23001) — a security property, not an obstacle to work around. Reusing a
 * single account keeps the probe idempotent and leaves exactly one row behind.
 */
const probeEmail = "probe.platform@hisab.test";
const probePassword = `Probe#${Math.random().toString(36).slice(2, 10)}`;
const probeUser = (
  await db.query(
    `insert into platform_users (id, email, password_hash, name, role, status)
     values (gen_random_uuid(), $1, $2, 'Platform probe', 'owner', 'active')
     on conflict (lower(email)) do update
       set password_hash = excluded.password_hash,
           name = excluded.name,
           status = 'active',
           totp_secret_cipher = null,
           totp_enrolled_at = null,
           locked_until = null
     returning id`,
    [probeEmail, await hashPassword(probePassword)],
  )
).rows[0] as { id: string };

try {
  const platformAction = await actionIdOf("/platform/login", PREVIEW_ORIGIN);
  const platformForm = (mail: string, pass: string) => {
    const data = new FormData();
    data.append("email", mail);
    data.append("password", pass);
    return data;
  };
  const platform = platformAction
    ? await submitAction("/platform/login", platformAction, [{ ok: false }, platformForm(probeEmail, probePassword)], previewHeaders)
    : null;
  record(
    "the console login action transport works too",
    Boolean(platform) && !platform!.text.includes("Invalid Server Actions request"),
    platform ? `HTTP ${platform.status}` : "no action id on /platform/login",
  );

  if (!platform) {
    record("console enrollment could be exercised", false, "the login action never ran");
  } else if (platform.cookies.some((c) => c.startsWith("hisab_platform_session="))) {
    record("console enrollment could be exercised", false, "a fresh owner account should not be enrolled yet");
  } else {
    const enrollPointer = platform.text.includes("/platform/login/enroll");
    record(
      "an unenrolled owner is sent to the enrollment screen",
      enrollPointer,
      enrollPointer ? "enrollment offered" : "no enrollment pointer in the response",
    );

    const pending = platform.cookies.find((c) => c.startsWith("hisab_platform_2fa="))?.split(";")[0];
    // the enrollment screen only renders with the pending 2FA cookie; without it the server
    // sends the visitor back to the login form (so the cookie must be sent with this GET too)
    const enrollAction = await actionIdOf("/platform/login/enroll", PREVIEW_ORIGIN, pending);
    record(
      "the enrollment screen is reachable with the pending cookie",
      Boolean(pending && enrollAction),
      pending ? (enrollAction ? "screen renders its form" : "no action id — redirected to login?") : "no pending cookie",
    );

    if (pending && enrollAction) {
      const step = (fields: Record<string, string>) => {
        const data = new FormData();
        for (const [key, value] of Object.entries(fields)) data.append(key, value);
        return data;
      };
      const startStep = await submitAction("/platform/login/enroll", enrollAction, [{ ok: false }, step({ step: "start" })], {
        ...previewHeaders,
        cookie: pending,
      });
      const secret = /"secret":"([A-Z2-7]{16,})"/.exec(startStep.text)?.[1];
      record(
        "enrollment proposes a TOTP secret",
        Boolean(secret),
        secret ? `${secret.slice(0, 6)}… (length ${secret.length})` : "none returned",
      );

      if (secret) {
        const pending2 = startStep.cookies.find((c) => c.startsWith("hisab_platform_2fa="))?.split(";")[0] ?? pending;
        const confirmStep = await submitAction(
          "/platform/login/enroll",
          enrollAction,
          [{ ok: false }, step({ step: "confirm", code: totp(secret) })],
          { ...previewHeaders, cookie: pending2 },
        );
        const session = confirmStep.cookies.find((c) => c.startsWith("hisab_platform_session="));
        record(
          "confirming the code opens a platform session",
          Boolean(session),
          session ? "hisab_platform_session set" : `HTTP ${confirmStep.status} — no session`,
        );
        if (session) {
          const consolePage = await fetch(`${BASE}/platform`, {
            headers: { cookie: session.split(";")[0]!, origin: PREVIEW_ORIGIN },
            redirect: "manual",
          });
          record("the enrolled session opens the console", consolePage.status === 200, `/platform HTTP ${consolePage.status}`);
        }
      }
    }
  }
} finally {
  // revoke what the probe created: the session it opened and its rate-limit buckets. The
  // account itself stays (append-only audit references it) but is left disabled and unenrolled.
  await db.query(`delete from sessions where platform_user_id = $1::uuid`, [probeUser.id]);
  await db.query(`delete from rate_limits where bucket like $1`, [`%${probeEmail}%`]);
  await db.query(`update platform_users set status = 'disabled' where id = $1::uuid`, [probeUser.id]);
}

await db.end();
const failed = checks.filter((c) => !c.ok);
console.log(
  `\n${failed.length === 0 ? "LOGIN PROBE PASSED" : "LOGIN PROBE FAILED"} — ${checks.length - failed.length}/${checks.length} checks`,
);
if (failed.length > 0) process.exit(1);
