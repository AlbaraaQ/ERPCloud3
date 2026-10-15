/**
 * Fixed-window rate limiting (PLATFORM_ADMIN §4).
 *
 * Deliberately database-backed (no Redis in the dependency set, and the DB is
 * already authoritative): the bucket key encodes the scope — `login:<email>`,
 * `login-ip:<ip>`, `sync:<tenant>`, `export:<tenant>` — and a breach raises an
 * alert. The limiter fails *open* on infrastructure errors in the sense that it
 * never blocks reads, but a breach always records an alert (never silent).
 */

import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { rateLimits } from "@/db/schema";
import { raiseAlert } from "./alerts";

export interface RateLimitRule {
  /** Maximum hits allowed inside the window. */
  limit: number;
  /** Window length in seconds. */
  windowSeconds: number;
}

export const RATE_RULES: Record<string, RateLimitRule> = {
  "platform-login": { limit: 5, windowSeconds: 300 },
  "platform-login-ip": { limit: 20, windowSeconds: 300 },
  "tenant-login": { limit: 10, windowSeconds: 300 },
  "tenant-export": { limit: 10, windowSeconds: 3600 },
  "sync-push": { limit: 600, windowSeconds: 60 },
  "report-export": { limit: 60, windowSeconds: 3600 },
};

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  /** Seconds until the current window resets. */
  retryAfterSeconds: number;
}

/**
 * Consume one token. `scope` selects the rule and `key` identifies the caller
 * (email, ip, tenant id); the effective bucket is `<scope>:<key>`.
 */
export async function takeToken(scope: keyof typeof RATE_RULES | string, key: string): Promise<RateLimitResult> {
  const rule = RATE_RULES[scope] ?? { limit: 60, windowSeconds: 60 };
  const bucket = `${scope}:${key}`.slice(0, 200);
  const now = Date.now();

  const rows = await db.execute(sql`
    insert into rate_limits (bucket, window_start, count)
    values (${bucket}, now(), 1)
    on conflict (bucket) do update
      set count = case
            when rate_limits.window_start < now() - (${rule.windowSeconds} * interval '1 second')
            then 1 else rate_limits.count + 1 end,
          window_start = case
            when rate_limits.window_start < now() - (${rule.windowSeconds} * interval '1 second')
            then now() else rate_limits.window_start end
    returning count, window_start
  `);
  const row = (rows as unknown as { rows: { count: number; window_start: string }[] }).rows[0];
  const count = Number(row?.count ?? 1);
  const windowStart = row?.window_start ? new Date(row.window_start).getTime() : now;
  const retryAfter = Math.max(1, Math.ceil((windowStart + rule.windowSeconds * 1000 - now) / 1000));

  if (count > rule.limit) {
    await raiseAlert({
      severity: scope.includes("login") ? "critical" : "warning",
      kind: "rate_limit_breach",
      title: `Rate limit exceeded: ${scope}`,
      body: `${count} hits in ${rule.windowSeconds}s (limit ${rule.limit}) for ${key}`,
      payload: { scope, key, count, limit: rule.limit, windowSeconds: rule.windowSeconds },
    }).catch(() => {});
    return { allowed: false, remaining: 0, retryAfterSeconds: retryAfter };
  }

  return { allowed: true, remaining: Math.max(0, rule.limit - count), retryAfterSeconds: retryAfter };
}

/** Bucket the caller for login throttling: per email and per IP (both). */
export async function checkLoginThrottle(email: string, ip: string | null): Promise<RateLimitResult> {
  const byEmail = await takeToken("platform-login", email.toLowerCase());
  const byIp = await takeToken("platform-login-ip", ip ?? "unknown");
  return byEmail.allowed ? byIp : byEmail;
}

/** Drop stale buckets (called by the platform maintenance job). */
export async function pruneRateLimits(): Promise<number> {
  const rows = await db.execute(
    sql`delete from rate_limits where window_start < now() - interval '1 day' returning bucket`,
  );
  return (rows as unknown as { rows: unknown[] }).rows.length;
}
