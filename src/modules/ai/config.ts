/**
 * Assistant configuration per tenant (AI_ASSISTANT §1, §6).
 *
 * Two switches, because one is not enough:
 *   - tenant ON/OFF (`ai_tenant_config.enabled`, default OFF) — the tenant decides;
 *   - platform global flag (`ai_assistant`) — the operator can stop every tenant at
 *     once during an incident without editing every row.
 * With either off, the assistant is *unavailable*: the UI says so and no provider
 * call is made. There is no "partially enabled" state.
 */

import { and, eq, isNull, or } from "drizzle-orm";
import { db } from "@/db";
import { aiTenantConfig, featureFlags, tenants } from "@/db/schema";
import { errors } from "@/modules/shared/result";
import { writeAudit } from "@/modules/shared/audit";
import type { DbExecutor } from "@/modules/shared/db-context";
import { providerKeyPresent, PROVIDER_IDS } from "./providers";

/** Feature-flag key that acts as the platform-wide kill switch. */
export const AI_GLOBAL_FLAG = "ai_assistant";

export type AiDataScope = "metrics_only" | "names_allowed";

export interface AiConfig {
  tenantId: string;
  enabled: boolean;
  provider: string;
  model: string;
  baseUrl: string | null;
  /** env var NAME — never the key itself */
  secretRef: string | null;
  dataScope: AiDataScope;
  retentionDays: number;
  updatedByLabel: string | null;
}

export interface AiAvailability {
  available: boolean;
  /** i18n key explaining an unavailable assistant (never a stack trace) */
  reasonKey?: string;
  detail?: string;
  config: AiConfig | null;
}

const DEFAULTS = {
  enabled: false,
  provider: "openai",
  model: "",
  baseUrl: null as string | null,
  secretRef: null as string | null,
  dataScope: "metrics_only" as AiDataScope,
  retentionDays: 30,
};

export function defaultAiConfig(tenantId: string): AiConfig {
  return { tenantId, updatedByLabel: null, ...DEFAULTS };
}

/** Read the tenant's configuration (defaults when no row exists yet). */
export async function getAiConfig(tenantId: string, exec: DbExecutor = db): Promise<AiConfig> {
  const [row] = await exec.select().from(aiTenantConfig).where(eq(aiTenantConfig.tenantId, tenantId)).limit(1);
  if (!row) return defaultAiConfig(tenantId);
  return {
    tenantId: row.tenantId,
    enabled: row.enabled,
    provider: row.provider,
    model: row.model,
    baseUrl: row.baseUrl,
    secretRef: row.secretRef,
    dataScope: row.dataScope as AiDataScope,
    retentionDays: row.retentionDays,
    updatedByLabel: row.updatedByLabel,
  };
}

/**
 * Whether the assistant may serve this tenant right now.
 *
 * Order matters: the platform kill switch is checked first (an incident outranks
 * a tenant's preference), then the tenant's own switch, then whether the provider
 * is actually usable. Everything that fails is reported as *unavailable with a
 * reason*, never as an empty answer.
 */
export async function aiAvailability(tenantId: string, exec: DbExecutor = db): Promise<AiAvailability> {
  const config = await getAiConfig(tenantId, exec);

  const globalOn = await aiGloballyEnabled(tenantId, exec).catch(() => false);
  if (!globalOn) {
    return { available: false, reasonKey: "errors.aiDisabledPlatform", config };
  }
  if (!config.enabled) {
    return { available: false, reasonKey: "errors.aiDisabledTenant", config };
  }
  /**
   * A suspended/deactivated tenant is READ ONLY in the database (PLATFORM_ADMIN
   * §1.1 — suspension preserves history, it never deletes it), and the assistant
   * has no mode that answers without writing its audit rows. So it degrades to
   * "unavailable" with a reason instead of answering unlogged.
   */
  if (!(await assistantTenantWritable(tenantId, exec))) {
    return { available: false, reasonKey: "errors.aiTenantReadOnly", config };
  }
  if (!(PROVIDER_IDS as readonly string[]).includes(config.provider)) {
    return { available: false, reasonKey: "errors.aiProviderUnsupported", config };
  }
  if (!config.model) {
    return { available: false, reasonKey: "errors.aiNotConfigured", detail: "no model", config };
  }
  if (!providerKeyPresent(config.secretRef)) {
    return {
      available: false,
      reasonKey: "errors.aiNotConfigured",
      detail: `environment variable ${config.secretRef ?? "(none)"} is not set`,
      config,
    };
  }
  return { available: true, config };
}

/** Tenant states whose data may still be written to (PLATFORM_ADMIN §1.1). */
const WRITABLE_STATUSES = new Set(["trial", "active"]);

/**
 * Whether this tenant's data may be written to right now.
 *
 * The assistant's transcript and tool-call audit are mandatory, not best-effort —
 * an answer nobody can audit is worse than no answer — so this is part of
 * availability, not a warning shown later.
 */
export async function assistantTenantWritable(tenantId: string, exec: DbExecutor = db): Promise<boolean> {
  const [row] = await exec.select({ status: tenants.status }).from(tenants).where(eq(tenants.id, tenantId)).limit(1);
  return Boolean(row) && WRITABLE_STATUSES.has(String(row.status));
}

/**
 * Global kill switch, with an explicit default: a flag row that does not exist is
 * NOT an outage. The assistant is off by default because tenants have not opted in
 * (their own switch), not because an operator forgot to create a row — otherwise a
 * fresh install could never be enabled without a seed step.
 */
export async function aiGloballyEnabled(tenantId: string, exec: DbExecutor = db): Promise<boolean> {
  // Both branches must be about THIS flag. Written as one raw `a = … and b = … or c`
  // string it reads as `(a and b) or c` in SQL, and the loose tail made every other
  // global flag row a candidate — so an unrelated flag (enabled by default in the
  // platform console) silently outranked the assistant's own kill switch. The
  // grouping is now explicit and non-negotiable.
  const rows = await exec
    .select({ tenantId: featureFlags.tenantId, enabled: featureFlags.enabled })
    .from(featureFlags)
    .where(
      and(
        eq(featureFlags.key, AI_GLOBAL_FLAG),
        or(eq(featureFlags.tenantId, tenantId), isNull(featureFlags.tenantId)),
      ),
    );
  const tenantRow = rows.find((r) => r.tenantId !== null);
  if (tenantRow) return tenantRow.enabled;
  const globalRow = rows.find((r) => r.tenantId === null);
  return globalRow ? globalRow.enabled : true;
}

/** True when a platform-wide kill switch row exists and is off (for the console). */
export async function aiKillSwitchEngaged(exec: DbExecutor = db): Promise<boolean> {
  const [row] = await exec
    .select({ enabled: featureFlags.enabled })
    .from(featureFlags)
    .where(and(eq(featureFlags.key, AI_GLOBAL_FLAG), isNull(featureFlags.tenantId)))
    .limit(1);
  return Boolean(row) && !row!.enabled;
}

export interface SaveAiConfigInput {
  tenantId: string;
  patch: Partial<Pick<AiConfig, "enabled" | "provider" | "model" | "baseUrl" | "secretRef" | "dataScope" | "retentionDays">>;
  actorUserId: string;
  actorLabel: string;
}

/**
 * Persist the configuration. Audited in the tenant's own chain (D-018) inside the
 * same transaction as the change — turning the assistant on is a security-relevant
 * decision, and it must be visible in the tenant's audit trail, not only in logs.
 */
export async function saveAiConfig(input: SaveAiConfigInput): Promise<AiConfig> {
  const patch = input.patch;
  if (patch.provider && !(PROVIDER_IDS as readonly string[]).includes(patch.provider)) {
    throw errors.validation("errors.aiProviderUnsupported", `unknown provider: ${patch.provider}`);
  }
  if (patch.retentionDays !== undefined && (patch.retentionDays < 1 || patch.retentionDays > 365)) {
    throw errors.validation("errors.aiRetentionRange", `retention ${patch.retentionDays} outside 1..365 days`);
  }
  if (patch.secretRef && !/^[A-Z][A-Z0-9_]{2,119}$/.test(patch.secretRef)) {
    // the field holds an env var NAME; a raw key pasted here must be refused, and
    // refusing loudly is the only way an operator notices the mistake
    throw errors.validation("errors.aiSecretRefInvalid", `not an env var name: ${patch.secretRef.slice(0, 20)}`);
  }

  const before = await getAiConfig(input.tenantId);
  const next: AiConfig = { ...before, ...patch, tenantId: input.tenantId, updatedByLabel: input.actorLabel };

  await db.transaction(async (trx) => {
    await trx
      .insert(aiTenantConfig)
      .values({
        tenantId: next.tenantId,
        enabled: next.enabled,
        provider: next.provider,
        model: next.model,
        baseUrl: next.baseUrl,
        secretRef: next.secretRef,
        dataScope: next.dataScope,
        retentionDays: next.retentionDays,
        updatedByLabel: next.updatedByLabel,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: aiTenantConfig.tenantId,
        set: {
          enabled: next.enabled,
          provider: next.provider,
          model: next.model,
          baseUrl: next.baseUrl,
          secretRef: next.secretRef,
          dataScope: next.dataScope,
          retentionDays: next.retentionDays,
          updatedByLabel: next.updatedByLabel,
          updatedAt: new Date(),
        },
      });

    await writeAudit(trx, {
      tenantId: input.tenantId,
      actorUserId: input.actorUserId,
      actorLabel: input.actorLabel,
      action: "ai.config.updated",
      entity: "ai_tenant_config",
      entityId: input.tenantId,
      before: { enabled: before.enabled, provider: before.provider, model: before.model, dataScope: before.dataScope, retentionDays: before.retentionDays },
      // the secret REF is safe to record; the secret itself is never read here
      after: { enabled: next.enabled, provider: next.provider, model: next.model, dataScope: next.dataScope, retentionDays: next.retentionDays, secretRef: next.secretRef },
    });
  });

  return next;
}
