/**
 * Tax identity & document classification (INVOICING_AND_ZATCA §1-2).
 * Missing seller config is a blocking ConfigurationError (INV-17) — never a
 * guessed rate, never a silent exemption.
 */

import { eq } from "drizzle-orm";
import { taxConfigs, companies, customers } from "@/db/schema";
import { and } from "drizzle-orm";
import type { Trx } from "@/modules/shared/db-context";
import { errors } from "@/modules/shared/result";
import type { DocType } from "./xml";

export interface SellerIdentityResolved {
  registrationName: string;
  vatNumber: string;
  crn: string | null;
  street: string | null;
  district: string | null;
  city: string | null;
  postalCode: string | null;
  env: "developer-portal" | "simulation" | "core";
  freeGoodsDeemedSupply: boolean;
}

/** Read the tenant tax config; null when e-invoicing not enabled. */
export async function getTaxConfig(trx: Trx, tenantId: string) {
  const [cfg] = await trx.select().from(taxConfigs).where(eq(taxConfigs.tenantId, tenantId)).limit(1);
  return cfg ?? null;
}

/**
 * Resolve full seller identity for XML. Throws ConfigurationError listing
 * exactly what is missing when e-invoicing is enabled.
 */
export async function resolveSellerIdentity(trx: Trx, tenantId: string): Promise<SellerIdentityResolved> {
  const cfg = await getTaxConfig(trx, tenantId);
  if (!cfg || !cfg.enabled) throw errors.configuration("errors.taxNotEnabled");
  const [co] = await trx.select().from(companies).where(eq(companies.tenantId, tenantId)).limit(1);
  if (!co) throw errors.configuration("errors.companyProfileMissing");

  const missing: string[] = [];
  if (!co.legalName) missing.push("legalName");
  if (!co.vatNumber) missing.push("vatNumber");
  if (!/^\d{15}$/.test(co.vatNumber ?? "")) missing.push("vatNumber(15)");
  if (!cfg.city) missing.push("city");
  if (!cfg.postalCode) missing.push("postalCode");
  if (missing.length > 0) {
    throw errors.configuration("errors.taxConfigIncomplete", `missing: ${missing.join(",")}`, { missing });
  }
  return {
    registrationName: co.legalName,
    vatNumber: co.vatNumber!,
    crn: co.crNumber ?? null,
    street: cfg.street ?? null,
    district: cfg.district ?? null,
    city: cfg.city!,
    postalCode: cfg.postalCode!,
    env: cfg.env,
    freeGoodsDeemedSupply: cfg.freeGoodsDeemedSupply,
  };
}

/**
 * Document classification (IZ §1): registered buyer → standard (clearance
 * required); otherwise simplified (reporting). Returns mirror the original's
 * classification as credit notes.
 */
export async function classifyInvoice(
  trx: Trx,
  tenantId: string,
  customerId: string | null,
  invoiceType: "sale" | "sale_return",
): Promise<{ docType: DocType; docSubtype: "invoice" | "credit_note" }> {
  let buyerVat: string | null = null;
  if (customerId) {
    const [c] = await trx
      .select({ taxNumber: customers.taxNumber })
      .from(customers)
      .where(and(eq(customers.tenantId, tenantId), eq(customers.id, customerId)))
      .limit(1);
    buyerVat = c?.taxNumber ?? null;
  }
  const isStandard = Boolean(buyerVat && /^\d{15}$/.test(buyerVat));
  return {
    docType: isStandard ? "standard" : "simplified",
    docSubtype: invoiceType === "sale_return" ? "credit_note" : "invoice",
  };
}

/** PaymentMeansCode for UBL (verify mapping at onboarding). */
export function paymentMeansCodeFor(methods: string[]): string {
  if (methods.length === 0) return "30"; // credit/settlement
  if (methods.includes("card")) return "48";
  if (methods.includes("cash")) return "10";
  if (methods.includes("bank_transfer")) return "30";
  return "30";
}
