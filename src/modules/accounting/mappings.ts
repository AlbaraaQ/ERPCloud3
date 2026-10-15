/**
 * Posting-mapping resolver (INV-17): a missing mapping is a blocking
 * ConfigurationError with an actionable message — never an invented account.
 */

import { and, eq } from "drizzle-orm";
import { postingMappings } from "@/db/schema";
import type { Trx } from "@/modules/shared/db-context";
import { errors } from "@/modules/shared/result";
import { MAPPING_KEYS } from "./coa";

const known = new Set(MAPPING_KEYS.map((k) => k.key));
export const isMappingKey = (k: string) => known.has(k);

export async function resolveMappingId(trx: Trx, tenantId: string, key: string): Promise<string> {
  const [row] = await trx
    .select({ accountId: postingMappings.accountId })
    .from(postingMappings)
    .where(and(eq(postingMappings.tenantId, tenantId), eq(postingMappings.key, key)))
    .limit(1);
  if (!row) {
    const label = MAPPING_KEYS.find((k) => k.key === key)?.nameAr ?? key;
    throw errors.configuration(
      "errors.missingMapping",
      `missing posting mapping: ${key}`,
      { key, label },
    );
  }
  return row.accountId;
}

export async function resolveMany(
  trx: Trx,
  tenantId: string,
  keys: string[],
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const k of keys) out[k] = await resolveMappingId(trx, tenantId, k);
  return out;
}

export async function listMappingsWithStatus(trx: Trx, tenantId: string) {
  const rows = await trx
    .select({
      key: postingMappings.key,
      accountId: postingMappings.accountId,
    })
    .from(postingMappings)
    .where(eq(postingMappings.tenantId, tenantId));
  const byKey = new Map(rows.map((r) => [r.key, r.accountId]));
  return MAPPING_KEYS.map((mk) => ({
    ...mk,
    accountId: byKey.get(mk.key) ?? null,
  }));
}
