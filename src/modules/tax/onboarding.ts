/**
 * ZATCA onboarding automation (D-012/D-024).
 *
 * Replaces the manual credential capture with the documented platform flow:
 *
 *   1. EGS key pair + CSR              (./csr.ts — OpenSSL-verified encoding)
 *   2. POST {base}/compliance          → compliance CSID (OTP from the portal)
 *   3. POST {base}/compliance/invoices → the six mandatory compliance checks
 *                                        (standard/simplified × invoice/credit/debit)
 *   4. POST {base}/production/csids    → production CSID (`compliance_request_id`)
 *   5. PATCH {base}/production/csids   → renewal before expiry
 *
 * Every call is journaled (request id, response, validation messages) and the
 * results are platform-reported — never inferred. When the transport is the
 * mock one (dev/test gate) the local EGS CA issues a real certificate so the
 * whole chain stays cryptographically verifiable; production behaviour is
 * unchanged and always requires real ZATCA credentials.
 */

import { and, desc, eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { branches, companies, invoiceSubmissions, taxConfigs, zatcaCertificates, zatcaComplianceChecks } from "@/db/schema";
import type { Trx } from "@/modules/shared/db-context";
import { errors } from "@/modules/shared/result";
import { writeAudit } from "@/modules/shared/audit";
import { newId } from "@/modules/shared/ids";
import { generateCsr, inspectCsr } from "./csr";
import { getTaxConfig, resolveSellerIdentity } from "./config";
import {
  buildInvoiceXml,
  computeInvoiceHash,
  validateInvoiceXml,
  type DocSubtype,
  type DocType,
  type InvoiceXmlInput,
} from "./xml";
import { initialPih, inspectCertificate, verifyInvoiceSignature } from "./signature";
import { transportFor, type CsidResult, type TransportCreds } from "./transport";

export interface ComplianceDoc {
  kind: string;
  docType: DocType;
  docSubtype: DocSubtype;
}

/** Fixed order required by the platform. */
export const COMPLIANCE_DOCS: readonly ComplianceDoc[] = [
  { kind: "standard_invoice", docType: "standard", docSubtype: "invoice" },
  { kind: "standard_credit_note", docType: "standard", docSubtype: "credit_note" },
  { kind: "standard_debit_note", docType: "standard", docSubtype: "debit_note" },
  { kind: "simplified_invoice", docType: "simplified", docSubtype: "invoice" },
  { kind: "simplified_credit_note", docType: "simplified", docSubtype: "credit_note" },
  { kind: "simplified_debit_note", docType: "simplified", docSubtype: "debit_note" },
];

/** Compliance documents are format fixtures: 100.00 net at 15% → 15.00 VAT. */
const CHECK_LINE = {
  qty: "1.000000",
  unitPrice: "100.00",
  lineNet: "100.00",
  vatRate: "15",
  vatAmount: "15.00",
  net: "100.00",
  vat: "15.00",
  total: "115.00",
};

export interface OnboardingResult {
  step: "compliance_csid" | "compliance_checks" | "production_csid" | "renewal";
  ok: boolean;
  message: string;
  requestId?: string;
  expiresAt?: string;
  checks?: { kind: string; status: string; validationStatus: string | null }[];
}

/* ------------------------------------------------------------------ helpers */

async function activeDeviceKey(trx: Trx, tenantId: string, env: string) {
  const [key] = await trx
    .select()
    .from(zatcaCertificates)
    .where(
      and(
        eq(zatcaCertificates.tenantId, tenantId),
        eq(zatcaCertificates.env, env as "developer-portal"),
        eq(zatcaCertificates.kind, "device_key"),
        eq(zatcaCertificates.status, "active"),
      ),
    )
    .orderBy(desc(zatcaCertificates.createdAt))
    .limit(1);
  return key ?? null;
}

async function credential(trx: Trx, tenantId: string, env: string, kind: string) {
  const [row] = await trx
    .select()
    .from(zatcaCertificates)
    .where(
      and(
        eq(zatcaCertificates.tenantId, tenantId),
        eq(zatcaCertificates.env, env as "developer-portal"),
        eq(zatcaCertificates.kind, kind),
        eq(zatcaCertificates.status, "active"),
      ),
    )
    .orderBy(desc(zatcaCertificates.createdAt))
    .limit(1);
  return row ?? null;
}

function credsOf(row: { binarySecurityToken: string | null; secret: string | null }): TransportCreds {
  if (!row.binarySecurityToken || !row.secret) {
    throw errors.configuration("errors.taxCredentialIncomplete");
  }
  return { binarySecurityToken: row.binarySecurityToken, secret: row.secret };
}

/** Store a freshly issued CSID, rotating the previous one for that kind. */
async function storeCsid(
  trx: Trx,
  tenantId: string,
  env: string,
  kind: "compliance" | "production",
  result: CsidResult,
  deviceKeyId: string,
  csrBase64: string | null,
) {
  const token = result.binarySecurityToken!;
  const certificate = inspectCertificate(token); // throws when the payload is not an X.509
  await trx
    .update(zatcaCertificates)
    .set({ status: "rotated" })
    .where(
      and(
        eq(zatcaCertificates.tenantId, tenantId),
        eq(zatcaCertificates.env, env as "developer-portal"),
        eq(zatcaCertificates.kind, kind),
      ),
    );
  await trx.insert(zatcaCertificates).values({
    id: newId(),
    tenantId,
    env: env as "developer-portal",
    kind,
    label: `${kind} CSID (${env})`,
    binarySecurityToken: token,
    secret: result.secret ?? null,
    requestId: result.requestId ?? null,
    deviceKeyId,
    csr: csrBase64,
    certificateExpiresAt: certificate.notAfter,
    status: "active",
  });
  return certificate;
}

/* ------------------------------------------------------------- 1-2. CSIDs */

/**
 * Step 1-2: generate the EGS key pair + CSR (when absent) and request the
 * compliance CSID with the portal OTP.
 */
export async function requestComplianceCsid(
  trx: Trx,
  tenantId: string,
  input: { otp: string; actorId: string | null },
): Promise<OnboardingResult> {
  const cfg = await getTaxConfig(trx, tenantId);
  if (!cfg?.enabled) throw errors.configuration("errors.taxNotEnabled");
  if (!/^\d{6,8}$/.test(input.otp.trim())) {
    throw errors.validation("errors.zatcaOtpInvalid");
  }
  const seller = await resolveSellerIdentity(trx, tenantId);
  const [company] = await trx.select().from(companies).where(eq(companies.tenantId, tenantId)).limit(1);
  const [branch] = await trx
    .select()
    .from(branches)
    .where(and(eq(branches.tenantId, tenantId), eq(branches.isDefault, true)))
    .limit(1);

  const egsSerialNumber =
    cfg.egsSerialNumber ?? `1-ERPCloud|2-ERP|3-${randomUUID().slice(0, 18)}`;

  const csr = generateCsr({
    env: cfg.env,
    egsSerialNumber,
    vatNumber: seller.vatNumber,
    organizationName: (company?.legalNameEn ?? company?.legalName ?? seller.registrationName).slice(0, 60),
    organizationalUnitName: (branch?.name ?? company?.legalName ?? "Branch").slice(0, 60),
    commonName: undefined, // env default: TST-/PRE-<serial>
    registeredAddress: `${seller.street ?? ""} ${seller.city ?? ""}`.trim().slice(0, 60) || seller.city!,
    businessCategory: (cfg.industry ?? "General").slice(0, 60),
    invoiceType: "1100",
    country: "SA",
  });
  inspectCsr(csr.csrDer); // structural self-check before submitting (never send a malformed CSR)

  // the previous EGS key/CSR is superseded — a new key means a new CSID
  await trx
    .update(zatcaCertificates)
    .set({ status: "rotated" })
    .where(
      and(
        eq(zatcaCertificates.tenantId, tenantId),
        eq(zatcaCertificates.env, cfg.env),
        eq(zatcaCertificates.kind, "device_key"),
      ),
    );
  const deviceKeyId = newId();
  await trx.insert(zatcaCertificates).values({
    id: deviceKeyId,
    tenantId,
    env: cfg.env,
    kind: "device_key",
    label: "EGS device key",
    privateKey: csr.privateKeyPem,
    publicKey: csr.publicKeySpkiPem,
    csr: csr.csrBase64,
    status: "active",
  });

  const transport = transportFor(cfg.env);
  // ZATCA accepts the CSR as base64; the SDK file convention is base64-of-PEM
  // while integrator implementations send base64-of-DER. Try DER first and fall
  // back once to PEM — both are legitimate encodings of the same CSR.
  let result = await transport.requestComplianceCsid({ csrBase64: csr.csrDerBase64, otp: input.otp.trim() });
  let encoding = "der";
  if (!result.ok && result.errorClass === "validation") {
    const retry = await transport.requestComplianceCsid({ csrBase64: csr.csrBase64, otp: input.otp.trim() });
    if (retry.ok) {
      result = retry;
      encoding = "pem";
    } else {
      result = retry;
    }
  }

  await writeAudit(trx, {
    tenantId,
    actorUserId: input.actorId,
    actorLabel: input.actorId ?? "system",
    action: "tax.onboarding.compliance_csid",
    entity: "zatca_certificate",
    entityId: deviceKeyId,
    after: {
      ok: result.ok,
      httpStatus: result.httpStatus,
      encoding,
      requestId: result.requestId ?? null,
      error: result.errorMessage ?? null,
      template: csr.templateName,
      commonName: csr.commonName,
    },
  });

  if (!result.ok) {
    return {
      step: "compliance_csid",
      ok: false,
      message: result.errorMessage ?? "compliance CSID request failed",
    };
  }

  const certificate = await storeCsid(
    trx,
    tenantId,
    cfg.env,
    "compliance",
    result,
    deviceKeyId,
    csr.csrBase64,
  );

  // The mock transport cannot sign the submitted CSR, so it certifies a key pair
  // it mints itself and returns it — store that key so signatures verify.
  if (result.devicePrivateKeyPem) {
    await trx
      .update(zatcaCertificates)
      .set({ status: "rotated" })
      .where(and(eq(zatcaCertificates.tenantId, tenantId), eq(zatcaCertificates.id, deviceKeyId)));
    const replacementId = newId();
    await trx.insert(zatcaCertificates).values({
      id: replacementId,
      tenantId,
      env: cfg.env,
      kind: "device_key",
      label: "EGS device key (local CA)",
      privateKey: result.devicePrivateKeyPem,
      publicKey: certificate.publicKeyPem,
      csr: csr.csrBase64,
      status: "active",
    });
    await trx
      .update(zatcaCertificates)
      .set({ deviceKeyId: replacementId })
      .where(
        and(
          eq(zatcaCertificates.tenantId, tenantId),
          eq(zatcaCertificates.kind, "compliance"),
          eq(zatcaCertificates.status, "active"),
        ),
      );
  }

  await trx
    .update(taxConfigs)
    .set({
      egsSerialNumber,
      complianceRequestId: result.requestId ?? null,
      onboardingState: "compliance",
      updatedAt: new Date(),
    })
    .where(eq(taxConfigs.tenantId, tenantId));

  return {
    step: "compliance_csid",
    ok: true,
    message: result.dispositionMessage ?? "compliance CSID issued",
    requestId: result.requestId,
    expiresAt: certificate.notAfter.toISOString(),
  };
}

/* ------------------------------------------------- 3. the six comp. checks */

/**
 * Step 3: build, sign and submit the six compliance documents. Each attempt is
 * journaled per document kind; retries reuse the same ICV/PIH/XML (idempotent,
 * INV-02) and only bump the attempt counter.
 */
export async function runComplianceChecks(
  trx: Trx,
  tenantId: string,
  actorId: string | null,
): Promise<OnboardingResult> {
  const cfg = await getTaxConfig(trx, tenantId);
  if (!cfg?.enabled) throw errors.configuration("errors.taxNotEnabled");

  const compliance = await credential(trx, tenantId, cfg.env, "compliance");
  if (!compliance) throw errors.configuration("errors.taxComplianceCredentialMissing");
  const deviceKey = compliance.deviceKeyId
    ? (
        await trx
          .select()
          .from(zatcaCertificates)
          .where(
            and(
              eq(zatcaCertificates.tenantId, tenantId),
              eq(zatcaCertificates.id, compliance.deviceKeyId),
            ),
          )
          .limit(1)
      )[0]
    : await activeDeviceKey(trx, tenantId, cfg.env);
  if (!deviceKey?.privateKey) throw errors.configuration("errors.taxDeviceKeyMissing");

  const seller = await resolveSellerIdentity(trx, tenantId);
  const [company] = await trx.select().from(companies).where(eq(companies.tenantId, tenantId)).limit(1);

  const existing = await trx
    .select()
    .from(zatcaComplianceChecks)
    .where(
      and(
        eq(zatcaComplianceChecks.tenantId, tenantId),
        eq(zatcaComplianceChecks.env, cfg.env),
        eq(zatcaComplianceChecks.status, "passed"),
      ),
    );
  const passedKinds = new Set(existing.map((r) => r.docKind));
  const runId = existing[0]?.runId ?? randomUUID();

  const transport = transportFor(cfg.env);
  const creds = credsOf(compliance);
  const results: OnboardingResult["checks"] = [];
  let previousHash = initialPih();
  let index = 0;

  for (const doc of COMPLIANCE_DOCS) {
    index += 1;
    const [row] = await trx
      .select()
      .from(zatcaComplianceChecks)
      .where(
        and(
          eq(zatcaComplianceChecks.tenantId, tenantId),
          eq(zatcaComplianceChecks.env, cfg.env),
          eq(zatcaComplianceChecks.runId, runId),
          eq(zatcaComplianceChecks.docKind, doc.kind),
        ),
      )
      .limit(1);

    if (row?.status === "passed") {
      results.push({ kind: doc.kind, status: "passed", validationStatus: row.validationStatus });
      previousHash = row.invoiceHash ?? previousHash;
      continue;
    }

    const icv = row?.icv ?? index;
    const pih = row?.previousHash ?? previousHash;
    let xml = row?.xml ?? null;
    let invoiceUuid = row?.invoiceUuid ?? randomUUID();

    if (!xml) {
      const input: InvoiceXmlInput = {
        invoiceNumber: `COMP-${doc.kind.replace(/_/g, "-").toUpperCase()}`,
        uuid: invoiceUuid,
        icv,
        previousHashB64: pih,
        issueDate: new Date().toISOString().slice(0, 10),
        issueTime: new Date().toISOString().slice(11, 19),
        docType: doc.docType,
        docSubtype: doc.docSubtype,
        transactionFlags: {},
        currency: "SAR",
        seller,
        buyer: {
          // the compliance documents are format fixtures: the buyer is the EGS
          // owner itself (a format-valid 15-digit VAT, no third party invented)
          registrationName: company?.legalName ?? seller.registrationName,
          vatNumber: seller.vatNumber,
          identification: { schemeId: "NAT", value: seller.vatNumber },
          street: seller.street,
          buildingNo: seller.buildingNo,
          plotIdentification: seller.plotIdentification,
          district: seller.district,
          city: seller.city,
          postalCode: seller.postalCode,
        },
        deliveryDate: new Date().toISOString().slice(0, 10),
        paymentMeansCodes: ["10"],
        instructionNote: doc.docSubtype === "invoice" ? null : "Compliance check document",
        netTotal: CHECK_LINE.net,
        discountTotal: "0.00",
        vatTotal: CHECK_LINE.vat,
        totalWithVat: CHECK_LINE.total,
        taxSubtotals: [
          { category: "S", rate: "15", taxable: CHECK_LINE.net, tax: CHECK_LINE.vat },
        ],
        lines: [
          {
            lineNo: 1,
            productName: "Compliance check line",
            qty: CHECK_LINE.qty,
            unitCode: "PCE",
            unitPrice: CHECK_LINE.unitPrice,
            lineNet: CHECK_LINE.lineNet,
            discountAmount: "0.00",
            vatRate: CHECK_LINE.vatRate,
            vatAmount: CHECK_LINE.vatAmount,
            taxCategory: "S",
            free: false,
          },
        ],
        billingReference:
          doc.docSubtype === "invoice"
            ? null
            : { invoiceNumber: `COMP-STANDARD-INVOICE`, uuid: null },
        signature: {
          certificateB64Der: compliance.binarySecurityToken!,
          privateKeyPem: deviceKey.privateKey,
          signingTimeIso: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
        },
      };
      xml = buildInvoiceXml(input);
      // the document must satisfy the rule set before it is submitted — the
      // platform rejects a non-conforming compliance document outright
      const issues = validateInvoiceXml(xml, input).filter((i) => i.severity === "error");
      if (issues.length > 0) {
        throw errors.configuration(
          "errors.taxComplianceDocInvalid",
          `${doc.kind}: ${issues.map((i) => `${i.code}:${i.field}`).join(",")}`,
          { kind: doc.kind, issues },
        );
      }
      // local proof before submission: signature must verify as built
      const verified = verifyInvoiceSignature(xml);
      if (!verified.signatureValid || !verified.digestValid || !verified.signedPropertiesValid) {
        throw errors.invariant("compliance document signature failed self-verification", {
          kind: doc.kind,
          verified,
        });
      }
    }

    const hash = computeInvoiceHash(xml);
    const outcome = await transport.complianceCheck(
      { invoiceHash: hash.b64, uuid: invoiceUuid, invoice: Buffer.from(xml, "utf8").toString("base64") },
      creds,
    );

    const values = {
      tenantId,
      env: cfg.env,
      runId,
      docKind: doc.kind,
      status: outcome.ok ? "passed" : "failed",
      invoiceUuid,
      icv,
      invoiceHash: hash.b64,
      previousHash: pih,
      xml,
      qrBase64: extractQr(xml),
      validationStatus: outcome.validationStatus ?? null,
      response: (outcome.raw ?? null) as Record<string, unknown> | null,
      errorMessages: outcome.errors.length > 0 ? outcome.errors : null,
      warningMessages: outcome.warnings.length > 0 ? outcome.warnings : null,
      attempts: (row?.attempts ?? 0) + 1,
      updatedAt: new Date(),
    };

    if (row) {
      await trx.update(zatcaComplianceChecks).set(values).where(eq(zatcaComplianceChecks.id, row.id));
    } else {
      await trx.insert(zatcaComplianceChecks).values({ id: newId(), ...values });
    }

    await writeAudit(trx, {
      tenantId,
      actorUserId: actorId,
      actorLabel: actorId ?? "system",
      action: `tax.onboarding.compliance_check.${outcome.ok ? "passed" : "failed"}`,
      entity: "zatca_compliance_check",
      entityId: `${runId}/${doc.kind}`,
      after: {
        kind: doc.kind,
        icv,
        validationStatus: outcome.validationStatus,
        errors: outcome.errors.slice(0, 5),
        warnings: outcome.warnings.slice(0, 5),
      },
    });

    results.push({
      kind: doc.kind,
      status: outcome.ok ? "passed" : "failed",
      validationStatus: outcome.validationStatus ?? null,
    });
    previousHash = hash.b64;

    if (!outcome.ok) {
      return {
        step: "compliance_checks",
        ok: false,
        message:
          outcome.errors.map((e) => `${e.code ?? ""} ${e.message ?? ""}`.trim()).join(" | ") ||
          "compliance check rejected the document",
        checks: results,
      };
    }
  }

  const allPassed = COMPLIANCE_DOCS.every((d) => passedKinds.has(d.kind) || results.some((r) => r.kind === d.kind && r.status === "passed"));
  return {
    step: "compliance_checks",
    ok: allPassed,
    message: allPassed ? "all six compliance checks passed" : "some compliance checks did not pass",
    checks: results,
  };
}

function extractQr(xml: string): string | null {
  const m = /<cbc:ID>QR<\/cbc:ID>[\s\S]*?<cbc:EmbeddedDocumentBinaryObject[^>]*>([^<]+)</.exec(xml);
  return m?.[1]?.trim() ?? null;
}

/* ----------------------------------------------------- 4-5. production CSID */

/** Step 4: exchange the compliance CSID for the production CSID. */
export async function issueProductionCsid(
  trx: Trx,
  tenantId: string,
  actorId: string | null,
): Promise<OnboardingResult> {
  const cfg = await getTaxConfig(trx, tenantId);
  if (!cfg?.enabled) throw errors.configuration("errors.taxNotEnabled");
  const compliance = await credential(trx, tenantId, cfg.env, "compliance");
  if (!compliance) throw errors.configuration("errors.taxComplianceCredentialMissing");
  if (!compliance.requestId && !cfg.complianceRequestId) {
    throw errors.configuration("errors.taxComplianceRequestIdMissing");
  }

  const checks = await trx
    .select({ docKind: zatcaComplianceChecks.docKind, status: zatcaComplianceChecks.status })
    .from(zatcaComplianceChecks)
    .where(
      and(
        eq(zatcaComplianceChecks.tenantId, tenantId),
        eq(zatcaComplianceChecks.env, cfg.env),
        eq(zatcaComplianceChecks.status, "passed"),
      ),
    );
  const passed = new Set(checks.map((c) => c.docKind));
  const missing = COMPLIANCE_DOCS.filter((d) => !passed.has(d.kind));
  if (missing.length > 0) {
    throw errors.configuration(
      "errors.taxComplianceChecksIncomplete",
      missing.map((m) => m.kind).join(","),
      { missing: missing.map((m) => m.kind) },
    );
  }

  const transport = transportFor(cfg.env);
  const result = await transport.requestProductionCsid(
    (compliance.requestId ?? cfg.complianceRequestId)!,
    credsOf(compliance),
  ).catch((e: unknown) => ({
    ok: false,
    httpStatus: 0,
    errorClass: "network" as const,
    errorMessage: e instanceof Error ? e.message : String(e),
    errors: [],
    warnings: [],
  }) as CsidResult);

  await writeAudit(trx, {
    tenantId,
    actorUserId: actorId,
    actorLabel: actorId ?? "system",
    action: "tax.onboarding.production_csid",
    entity: "zatca_certificate",
    entityId: cfg.env,
    after: {
      ok: result.ok,
      httpStatus: result.httpStatus,
      requestId: result.requestId ?? null,
      error: result.errorMessage ?? null,
    },
  });

  if (!result.ok) {
    return {
      step: "production_csid",
      ok: false,
      message: result.errorMessage ?? "production CSID request failed",
    };
  }

  const certificate = await storeCsid(
    trx,
    tenantId,
    cfg.env,
    "production",
    result,
    compliance.deviceKeyId ?? "",
    compliance.csr,
  );
  await trx
    .update(taxConfigs)
    .set({ onboardingState: "production", updatedAt: new Date() })
    .where(eq(taxConfigs.tenantId, tenantId));

  return {
    step: "production_csid",
    ok: true,
    message: result.dispositionMessage ?? "production CSID issued",
    requestId: result.requestId,
    expiresAt: certificate.notAfter.toISOString(),
  };
}

/** Step 5: renew the production CSID (`PATCH /production/csids`). */
export async function renewProductionCsid(
  trx: Trx,
  tenantId: string,
  actorId: string | null,
): Promise<OnboardingResult> {
  const cfg = await getTaxConfig(trx, tenantId);
  if (!cfg?.enabled) throw errors.configuration("errors.taxNotEnabled");
  const production = await credential(trx, tenantId, cfg.env, "production");
  if (!production) throw errors.configuration("errors.taxProductionCredentialMissing");

  const transport = transportFor(cfg.env);
  const result = await transport.renewProductionCsid(
    production.binarySecurityToken!,
    credsOf(production),
  );

  await writeAudit(trx, {
    tenantId,
    actorUserId: actorId,
    actorLabel: actorId ?? "system",
    action: "tax.onboarding.production_csid_renewal",
    entity: "zatca_certificate",
    entityId: cfg.env,
    after: { ok: result.ok, httpStatus: result.httpStatus, error: result.errorMessage ?? null },
  });

  if (!result.ok) {
    return { step: "renewal", ok: false, message: result.errorMessage ?? "renewal failed" };
  }
  const certificate = await storeCsid(
    trx,
    tenantId,
    cfg.env,
    "production",
    result,
    production.deviceKeyId ?? "",
    production.csr,
  );
  return {
    step: "renewal",
    ok: true,
    message: result.dispositionMessage ?? "production CSID renewed",
    requestId: result.requestId,
    expiresAt: certificate.notAfter.toISOString(),
  };
}

/* ------------------------------------------------------------- status (UI) */

export interface OnboardingStatus {
  enabled: boolean;
  env: string;
  state: string;
  egsSerialNumber: string | null;
  complianceRequestId: string | null;
  hasDeviceKey: boolean;
  csr: string | null;
  compliance: { expiresAt: string | null; rotated: boolean } | null;
  production: { expiresAt: string | null; daysLeft: number | null } | null;
  checks: { kind: string; status: string; validationStatus: string | null; attempts: number }[];
  pendingSubmissions: number;
  canIssueProduction: boolean;
}

export async function getOnboardingStatus(
  trx: Trx,
  tenantId: string,
): Promise<OnboardingStatus> {
  const cfg = await getTaxConfig(trx, tenantId);
  if (!cfg) {
    return {
      enabled: false,
      env: "developer-portal",
      state: "none",
      egsSerialNumber: null,
      complianceRequestId: null,
      hasDeviceKey: false,
      csr: null,
      compliance: null,
      production: null,
      checks: [],
      pendingSubmissions: 0,
      canIssueProduction: false,
    };
  }
  const deviceKey = await activeDeviceKey(trx, tenantId, cfg.env);
  const compliance = await credential(trx, tenantId, cfg.env, "compliance");
  const production = await credential(trx, tenantId, cfg.env, "production");
  const checks = await trx
    .select({
      docKind: zatcaComplianceChecks.docKind,
      status: zatcaComplianceChecks.status,
      validationStatus: zatcaComplianceChecks.validationStatus,
      attempts: zatcaComplianceChecks.attempts,
      updatedAt: zatcaComplianceChecks.updatedAt,
    })
    .from(zatcaComplianceChecks)
    .where(and(eq(zatcaComplianceChecks.tenantId, tenantId), eq(zatcaComplianceChecks.env, cfg.env)))
    .orderBy(desc(zatcaComplianceChecks.updatedAt));

  const latestPerKind = new Map<string, (typeof checks)[number]>();
  for (const row of checks) if (!latestPerKind.has(row.docKind)) latestPerKind.set(row.docKind, row);

  const pending = await trx
    .select({ count: sql<number>`count(*)::int` })
    .from(invoiceSubmissions)
    .where(
      and(
        eq(invoiceSubmissions.tenantId, tenantId),
        sql`${invoiceSubmissions.status} in ('issued_pending_reporting','clearance_pending','failed_retryable')`,
      ),
    );

  const daysLeft = production?.certificateExpiresAt
    ? Math.floor((production.certificateExpiresAt.getTime() - Date.now()) / 86_400_000)
    : null;

  const passedKinds = new Set(
    [...latestPerKind.values()].filter((r) => r.status === "passed").map((r) => r.docKind),
  );

  return {
    enabled: cfg.enabled,
    env: cfg.env,
    state: cfg.onboardingState,
    egsSerialNumber: cfg.egsSerialNumber ?? null,
    complianceRequestId: cfg.complianceRequestId ?? null,
    hasDeviceKey: Boolean(deviceKey?.privateKey),
    csr: deviceKey?.csr ?? compliance?.csr ?? null,
    compliance: compliance
      ? {
          expiresAt: compliance.certificateExpiresAt?.toISOString() ?? null,
          rotated: false,
        }
      : null,
    production: production
      ? { expiresAt: production.certificateExpiresAt?.toISOString() ?? null, daysLeft }
      : null,
    checks: [...latestPerKind.values()].map((r) => ({
      kind: r.docKind,
      status: r.status,
      validationStatus: r.validationStatus,
      attempts: r.attempts,
    })),
    pendingSubmissions: Number(pending[0]?.count ?? 0),
    canIssueProduction:
      Boolean(compliance) &&
      COMPLIANCE_DOCS.every((d) => passedKinds.has(d.kind)),
  };
}
