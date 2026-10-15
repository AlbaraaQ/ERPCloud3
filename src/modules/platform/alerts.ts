/**
 * Platform alerts inbox (PLATFORM_ADMIN §1.4).
 *
 * Alerts are deduplicated by `kind` + tenant while open: a recurring condition
 * (stale backups, failing jobs, quota breach, isolation alarm) updates the
 * existing row's counter instead of flooding the inbox.
 */

import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { platformAlerts } from "@/db/schema";
import { newId } from "@/modules/shared/ids";

export type AlertSeverity = "info" | "warning" | "critical";
export type AlertStatus = "open" | "acknowledged" | "resolved";

export interface RaiseAlertInput {
  severity: AlertSeverity;
  kind: string;
  title: string;
  body?: string;
  tenantId?: string | null;
  payload?: Record<string, unknown>;
}

/**
 * Raise (or bump) an alert. Never throws: alerting must not be able to break the
 * operation it observes — a failure here is logged by the caller's caller.
 */
export async function raiseAlert(input: RaiseAlertInput): Promise<string> {
  const existing = await db
    .select({ id: platformAlerts.id })
    .from(platformAlerts)
    .where(
      and(
        eq(platformAlerts.kind, input.kind),
        eq(platformAlerts.status, "open"),
        input.tenantId
          ? eq(platformAlerts.tenantId, input.tenantId)
          : sql`${platformAlerts.tenantId} is null`,
      ),
    )
    .limit(1);

  if (existing[0]) {
    await db
      .update(platformAlerts)
      .set({
        occurrences: sql`${platformAlerts.occurrences} + 1`,
        lastSeenAt: new Date(),
        severity: input.severity,
        body: input.body ?? null,
        payload: input.payload ?? null,
      })
      .where(eq(platformAlerts.id, existing[0].id));
    return existing[0].id;
  }

  const id = newId();
  await db.insert(platformAlerts).values({
    id,
    severity: input.severity,
    kind: input.kind,
    tenantId: input.tenantId ?? null,
    title: input.title,
    body: input.body ?? null,
    payload: input.payload ?? null,
  });
  return id;
}

/** Resolve every open alert of a kind (used when the condition clears). */
export async function resolveAlerts(kind: string, tenantId?: string | null): Promise<number> {
  const rows = await db
    .update(platformAlerts)
    .set({ status: "resolved", resolvedAt: new Date() })
    .where(
      and(
        eq(platformAlerts.kind, kind),
        eq(platformAlerts.status, "open"),
        tenantId === undefined
          ? sql`true`
          : tenantId === null
            ? sql`${platformAlerts.tenantId} is null`
            : eq(platformAlerts.tenantId, tenantId),
      ),
    )
    .returning({ id: platformAlerts.id });
  return rows.length;
}

export async function listAlerts(opts: { status?: "open" | "acknowledged" | "resolved"; limit?: number } = {}) {
  const statuses: AlertStatus[] = opts.status ? [opts.status] : ["open", "acknowledged"];
  return db
    .select()
    .from(platformAlerts)
    .where(inArray(platformAlerts.status, statuses))
    .orderBy(sql`case ${platformAlerts.severity} when 'critical' then 0 when 'warning' then 1 else 2 end`, sql`${platformAlerts.lastSeenAt} desc`)
    .limit(opts.limit ?? 100);
}

export async function acknowledgeAlert(id: string, platformUserId: string): Promise<void> {
  await db
    .update(platformAlerts)
    .set({ status: "acknowledged", acknowledgedAt: new Date(), acknowledgedByPlatformUserId: platformUserId })
    .where(and(eq(platformAlerts.id, id), eq(platformAlerts.status, "open")));
}

export async function countOpenAlerts(): Promise<Record<AlertSeverity, number>> {
  const rows = await db
    .select({ severity: platformAlerts.severity, n: sql<number>`count(*)::int` })
    .from(platformAlerts)
    .where(inArray(platformAlerts.status, ["open", "acknowledged"]))
    .groupBy(platformAlerts.severity);
  const out: Record<AlertSeverity, number> = { info: 0, warning: 0, critical: 0 };
  for (const row of rows) out[row.severity] = Number(row.n);
  return out;
}
