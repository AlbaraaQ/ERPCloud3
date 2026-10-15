/**
 * Tax identity & document classification (INVOICING_AND_ZATCA §1-2).
 * Missing seller config is a blocking ConfigurationError (INV-17) — never a
 * guessed rate, never a silent exemption.
 */

import { eq, desc } from "drizzle-orm";
import { createPublicKey } from "node:crypto";
import { taxConfigs, companies, customers, zatcaCertificates } from "@/db/schema";
import { and } from "drizzle-orm";
import type { Trx } from "@/modules/shared/db-context";
import { errors } from "@/modules/shared/result";
import { PAYMENT_MEANS, type DocType } from "./xml";
import { inspectCertificate } from "./signature";

export interface SellerIdentityResolved {
  registrationName: string;
  vatNumber: string;
  crn: string | null;
  street: string | null;
  additionalStreet: string | null;
  buildingNo: string | null;
  plotIdentification: string | null;
  district: string | null;
  city: string | null;
  postalCode: string | null;
  env: "developer-portal" | "simulation" | "core";
  freeGoodsDeemedSupply: boolean;
}

export type CsidKind = "compliance" | "production";

export interface SigningMaterial {
  kind: CsidKind;
  env: SellerIdentityResolved["env"];
  /** base64 X.509 (ZATCA `binarySecurityToken`) */
  certificateB64Der: string;
  privateKeyPem: string;
  certificateExpiresAt: Date | null;
  deviceKeyId: string | null;
}

/**
 * Resolve the certificate + key that sign documents for a given stage.
 * Documents are signed with the EGS key pair whose CSR produced the CSID, so a
 * certificate that does not match the stored public key is refused instead of
 * producing an unverifiable signature (D-012: never fabricate).
 */
export async function resolveSigningMaterial(
  trx: Trx,
  tenantId: string,
  env: SellerIdentityResolved["env"],
  kind: CsidKind,
): Promise<SigningMaterial | null> {
  const [csid] = await trx
    .select()
    .from(zatcaCertificates)
    .where(
      and(
        eq(zatcaCertificates.tenantId, tenantId),
        eq(zatcaCertificates.env, env),
        eq(zatcaCertificates.kind, kind),
        eq(zatcaCertificates.status, "active"),
      ),
    )
    .orderBy(desc(zatcaCertificates.createdAt))
    .limit(1);
  if (!csid?.binarySecurityToken) return null;

  const keys = csid.deviceKeyId
    ? await trx
        .select()
        .from(zatcaCertificates)
        .where(and(eq(zatcaCertificates.tenantId, tenantId), eq(zatcaCertificates.id, csid.deviceKeyId)))
        .limit(1)
    : await trx
        .select()
        .from(zatcaCertificates)
        .where(
          and(
            eq(zatcaCertificates.tenantId, tenantId),
            eq(zatcaCertificates.env, env),
            eq(zatcaCertificates.kind, "device_key"),
            eq(zatcaCertificates.status, "active"),
          ),
        )
        .orderBy(desc(zatcaCertificates.createdAt))
        .limit(1);
  const key = keys[0];
  if (!key?.privateKey || !key.publicKey) return null;

  const certificate = inspectCertificate(csid.binarySecurityToken);
  const certPublicKey = Buffer.from(
    (createPublicKey(certificate.publicKeyPem).export({ type: "spki", format: "der" }) as Buffer),
  ).toString("base64");
  const storedPublicKey = Buffer.from(
    (createPublicKey(key.publicKey).export({ type: "spki", format: "der" }) as Buffer),
  ).toString("base64");
  if (certPublicKey !== storedPublicKey) {
    throw errors.configuration("errors.certificateKeyMismatch", kind);
  }

  return {
    kind,
    env,
    certificateB64Der: csid.binarySecurityToken.trim(),
    privateKeyPem: key.privateKey,
    certificateExpiresAt: certificate.notAfter,
    deviceKeyId: key.id,
  };
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
    additionalStreet: cfg.additionalStreet ?? null,
    buildingNo: cfg.buildingNo ?? null,
    plotIdentification: cfg.plotIdentification ?? null,
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

/**
 * Payment path → UBL PaymentMeansCode (UN/ECE 4461). Kept in one place; the
 * authoritative list lives in ./xml.ts (PAYMENT_MEANS) next to its tests.
 */
export function paymentMeansCodesFor(methods: string[]): string[] {
  const codes: string[] = [];
  if (methods.includes("cash")) codes.push(PAYMENT_MEANS.cash);
  if (methods.includes("card")) codes.push(PAYMENT_MEANS.card);
  if (methods.includes("bank_transfer")) codes.push(PAYMENT_MEANS.bankTransfer);
  if (codes.length === 0) codes.push(PAYMENT_MEANS.credit);
  return [...new Set(codes)];
}
