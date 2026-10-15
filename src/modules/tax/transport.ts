/**
 * ZATCA transport boundary (D-012).

 * Official environments (developer.zatca.gov.sa — confirmed current):
 *   developer-portal: https://gw-fatoora.zatca.gov.sa/e-invoicing/developer-portal
 *   simulation:       https://gw-fatoora.zatca.gov.sa/e-invoicing/simulation
 *   core (production):https://gw-fatoora.zatca.gov.sa/e-invoicing/core
 * Endpoints (POST):
 *   {base}/compliance                    request compliance CSID (OTP header)
 *   {base}/compliance/invoices           compliance checks
 *   {base}/production/csids              request production CSID (+PATCH renew)
 *   {base}/invoices/reporting/single     simplified invoices (Clearance-Status: 0)
 *   {base}/invoices/clearance/single     standard invoices (Clearance-Status: 1)
 * Auth: Basic base64(binarySecurityToken:secret); headers Accept-Version: V2,
 * Accept-Language, Content-Type application/json.
 *
 * MockTransport is dev/test-gated: it performs REAL local validation (rejects
 * malformed payloads) but synthesizes ACCEPTED outcomes — it never runs unless
 * ZATCA_TRANSPORT=mock or NODE_ENV=test; in production without real credentials
 * the transport refuses (InvariantViolation) rather than fabricating success.
 */

import { computeInvoiceHash } from "./xml";
import { isDomainError, errors } from "@/modules/shared/result";
import { logger } from "@/modules/shared/logger";

export const ZATCA_BASE_URLS: Record<string, string> = {
  "developer-portal": "https://gw-fatoora.zatca.gov.sa/e-invoicing/developer-portal",
  simulation: "https://gw-fatoora.zatca.gov.sa/e-invoicing/simulation",
  core: "https://gw-fatoora.zatca.gov.sa/e-invoicing/core",
};

export interface SubmissionPayload {
  invoiceHash: string; // b64
  uuid: string;
  invoice: string; // base64-encoded XML
}

export type TransportOutcomeKind = "accepted" | "rejected" | "transport_error";

export interface TransportOutcome {
  kind: TransportOutcomeKind;
  /** platform status strings e.g. REPORTED / CLEARED / REJECTED / WARNING */
  status?: string;
  clearedInvoiceB64?: string;
  validationStatus?: string;
  warnings: { type?: string; code?: string; message?: string }[];
  errors: { type?: string; code?: string; message?: string }[];
  httpStatus: number;
  raw?: Record<string, unknown>;
  errorClass?: "network" | "auth" | "validation" | "platform";
  errorMessage?: string;
}

export interface ComplianceCsidPayload {
  /** base64 DER of the EGS CSR (the SDK's `csr` field) */
  csrBase64: string;
  /** one-time password from the ZATCA portal */
  otp: string;
}

export interface CsidResult {
  ok: boolean;
  /** ZATCA `binarySecurityToken` — base64 X.509 (the CSID certificate) */
  binarySecurityToken?: string;
  secret?: string;
  /** requestID that must be replayed when requesting the production CSID */
  requestId?: string;
  dispositionMessage?: string;
  errors?: { code?: string; message?: string; category?: string }[];
  httpStatus: number;
  raw?: Record<string, unknown>;
  errorClass?: "network" | "auth" | "validation" | "platform";
  errorMessage?: string;
  /**
   * Mock/dev transport only: the locally issued CSID certifies a key pair the
   * mock minted (it holds no CA key), and the caller must store this key to be
   * able to sign. Real ZATCA responses never carry key material.
   */
  devicePrivateKeyPem?: string;
}

export interface ComplianceCheckResult {
  ok: boolean;
  /** PASS · WARNING · FAIL */
  validationStatus?: string;
  status?: string;
  warnings: { type?: string; code?: string; message?: string }[];
  errors: { type?: string; code?: string; message?: string }[];
  httpStatus: number;
  raw?: Record<string, unknown>;
  errorClass?: "network" | "auth" | "validation" | "platform";
  errorMessage?: string;
}

export interface ZatcaTransport {
  /** POST {base}/compliance — request the compliance CSID (OTP header). */
  requestComplianceCsid(p: ComplianceCsidPayload): Promise<CsidResult>;
  /** POST {base}/compliance/invoices — one of the six compliance checks. */
  complianceCheck(p: SubmissionPayload, creds: TransportCreds): Promise<ComplianceCheckResult>;
  /** POST {base}/production/csids — issue the production CSID (compliance creds). */
  requestProductionCsid(complianceRequestId: string, creds: TransportCreds): Promise<CsidResult>;
  /** PATCH {base}/production/csids — renew the production CSID (production creds). */
  renewProductionCsid(currentCsid: string, creds: TransportCreds): Promise<CsidResult>;
  reportSimplified(p: SubmissionPayload, creds: TransportCreds): Promise<TransportOutcome>;
  clearStandard(p: SubmissionPayload, creds: TransportCreds): Promise<TransportOutcome>;
}

export interface TransportCreds {
  binarySecurityToken: string;
  secret: string;
}

/* ------------------------------------------------------------------- HTTP */
export class HttpTransport implements ZatcaTransport {
  constructor(private baseUrl: string) {}

  private async call(
    path: string,
    body: Record<string, unknown>,
    creds: TransportCreds,
    clearanceStatus: 0 | 1,
  ): Promise<TransportOutcome> {
    const url = `${this.baseUrl}${path}`;
    const auth = Buffer.from(`${creds.binarySecurityToken}:${creds.secret}`).toString("base64");
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          authorization: `Basic ${auth}`,
          "content-type": "application/json",
          accept: "application/json",
          "accept-language": "en",
          "accept-version": "V2",
          "clearance-status": String(clearanceStatus),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
      const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;

      const vr = (json.validationResults ?? {}) as {
        infoMessages?: unknown[];
        warningMessages?: { type?: string; code?: string; message?: string }[];
        errorMessages?: { type?: string; code?: string; message?: string }[];
        status?: string;
      };
      const warnings = vr.warningMessages ?? [];
      const errorMessages = vr.errorMessages ?? [];

      if (res.status === 401 || res.status === 403) {
        return { kind: "transport_error", errorClass: "auth", errorMessage: `HTTP ${res.status}`, httpStatus: res.status, warnings: [], errors: [] };
      }
      const clearance = (json.clearanceStatus ?? json.clearanceResults ?? {}) as Record<string, unknown>;
      const reporting = (json.reportingStatus ?? json.reportingResults ?? {}) as Record<string, unknown>;
      const statusStr = (clearance.status ?? reporting.status ?? vr.status) as string | undefined;
      const clearedInvoiceB64 = (json.clearedInvoice ?? clearance.clearedInvoice) as string | undefined;

      const isRejected =
        res.status === 400 ||
        statusStr === "REJECTED" ||
        statusStr === "NOT_REPORTED" ||
        vr.status === "FAIL" ||
        errorMessages.length > 0 && !statusStr?.toUpperCase().includes("WARNING");

      if (isRejected) {
        return {
          kind: "rejected",
          status: statusStr,
          validationStatus: vr.status,
          warnings, errors: errorMessages, httpStatus: res.status, raw: json,
        };
      }
      return {
        kind: "accepted",
        status: statusStr,
        clearedInvoiceB64,
        validationStatus: vr.status,
        warnings, errors: [], httpStatus: res.status, raw: json,
      };
    } catch (e) {
      logger.warn({ err: e, url }, "zatca transport network error");
      return {
        kind: "transport_error",
        errorClass: "network",
        errorMessage: e instanceof Error ? e.message : String(e),
        httpStatus: 0,
        warnings: [],
        errors: [],
      };
    }
  }

  private async json(
    path: string,
    method: "POST" | "PATCH",
    body: Record<string, unknown>,
    headers: Record<string, string>,
  ): Promise<{ status: number; json: Record<string, unknown> } | { status: number; error: string }> {
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          "accept-language": "en",
          "accept-version": "V2",
          ...headers,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
      const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      return { status: res.status, json };
    } catch (e) {
      logger.warn({ err: e, path }, "zatca transport network error");
      return { status: 0, error: e instanceof Error ? e.message : String(e) };
    }
  }

  async requestComplianceCsid(p: ComplianceCsidPayload): Promise<CsidResult> {
    const res = await this.json("/compliance", "POST", { csr: p.csrBase64 }, { OTP: p.otp });
    if ("error" in res) {
      return { ok: false, httpStatus: 0, errorClass: "network", errorMessage: res.error };
    }
    return this.toCsidResult(res.status, res.json);
  }

  async complianceCheck(
    p: SubmissionPayload,
    creds: TransportCreds,
  ): Promise<ComplianceCheckResult> {
    const auth = Buffer.from(`${creds.binarySecurityToken}:${creds.secret}`).toString("base64");
    const res = await this.json(
      "/compliance/invoices",
      "POST",
      { invoiceHash: p.invoiceHash, uuid: p.uuid, invoice: p.invoice },
      { authorization: `Basic ${auth}` },
    );
    if ("error" in res) {
      return {
        ok: false,
        httpStatus: 0,
        errorClass: "network",
        errorMessage: res.error,
        warnings: [],
        errors: [],
      };
    }
    const vr = (res.json.validationResults ?? {}) as {
      status?: string;
      warningMessages?: ComplianceCheckResult["warnings"];
      errorMessages?: ComplianceCheckResult["errors"];
    };
    const errors = vr.errorMessages ?? [];
    const warnings = vr.warningMessages ?? [];
    const ok = res.status === 200 && vr.status !== "FAIL" && errors.length === 0;
    return {
      ok,
      validationStatus: vr.status,
      status: (res.json.clearanceStatus as string) ?? (res.json.reportingStatus as string),
      warnings,
      errors,
      httpStatus: res.status,
      raw: res.json,
      errorClass: ok ? undefined : res.status === 401 || res.status === 403 ? "auth" : "validation",
    };
  }

  async requestProductionCsid(
    complianceRequestId: string,
    creds: TransportCreds,
  ): Promise<CsidResult> {
    const auth = Buffer.from(`${creds.binarySecurityToken}:${creds.secret}`).toString("base64");
    const res = await this.json(
      "/production/csids",
      "POST",
      { compliance_request_id: complianceRequestId },
      { authorization: `Basic ${auth}` },
    );
    if ("error" in res) {
      return { ok: false, httpStatus: 0, errorClass: "network", errorMessage: res.error };
    }
    return this.toCsidResult(res.status, res.json);
  }

  async renewProductionCsid(currentCsid: string, creds: TransportCreds): Promise<CsidResult> {
    const auth = Buffer.from(`${creds.binarySecurityToken}:${creds.secret}`).toString("base64");
    const res = await this.json(
      "/production/csids",
      "PATCH",
      { csid: currentCsid },
      { authorization: `Basic ${auth}` },
    );
    if ("error" in res) {
      return { ok: false, httpStatus: 0, errorClass: "network", errorMessage: res.error };
    }
    return this.toCsidResult(res.status, res.json);
  }

  private toCsidResult(status: number, json: Record<string, unknown>): CsidResult {
    const token = (json.binarySecurityToken ?? json.binarySecuritytoken) as string | undefined;
    const secret = json.secret as string | undefined;
    const errors = (json.errors ?? []) as CsidResult["errors"];
    const ok = status === 200 && Boolean(token) && Boolean(secret);
    return {
      ok,
      binarySecurityToken: token,
      secret,
      requestId: json.requestID as string | undefined,
      dispositionMessage: json.dispositionMessage as string | undefined,
      errors,
      httpStatus: status,
      raw: json,
      errorClass: ok ? undefined : status === 401 || status === 403 ? "auth" : "validation",
      errorMessage: ok
        ? undefined
        : (errors?.[0]?.message ?? (json.dispositionMessage as string) ?? `HTTP ${status}`),
    };
  }

  reportSimplified(p: SubmissionPayload, creds: TransportCreds) {
    return this.call("/invoices/reporting/single", { invoiceHash: p.invoiceHash, uuid: p.uuid, invoice: p.invoice }, creds, 0);
  }

  clearStandard(p: SubmissionPayload, creds: TransportCreds) {
    return this.call("/invoices/clearance/single", { invoiceHash: p.invoiceHash, uuid: p.uuid, invoice: p.invoice }, creds, 1);
  }
}

/* -------------------------------------------------------------- Mock (dev) */
export class MockTransport implements ZatcaTransport {
  /** Simulates the platform for tests/dev ONLY — real local validation done. */
  private gate() {
    if (process.env.ZATCA_TRANSPORT !== "mock" && process.env.NODE_ENV !== "test") {
      throw errors.invariant("MockTransport used outside test/dev gate");
    }
  }

  private validate(p: SubmissionPayload): string | null {
    try {
      const xml = Buffer.from(p.invoice, "base64").toString("utf8");
      if (!xml.includes("<Invoice")) return "XML missing Invoice root";
      const hash = computeInvoiceHash(xml);
      if (hash.b64 !== p.invoiceHash) return "invoiceHash mismatch with XML";
      if (!/^[0-9a-f-]{36}$/i.test(p.uuid)) return "uuid invalid";
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : "parse error";
    }
  }

  /**
   * The sandbox gate has no real ZATCA CSR signing key, so the mock issues a
   * GENUINE X.509 certificate for the submitted CSR with the local EGS CA
   * (src/modules/tax/local-ca.ts) — the invoice chain is then signed and
   * verified with real cryptography instead of fake tokens. It is available
   * only under the mock/test gate and is never a ZATCA certificate.
   */
  async requestComplianceCsid(p: ComplianceCsidPayload): Promise<CsidResult> {
    this.gate();
    if (!p.otp || p.otp.length < 6) {
      return {
        ok: false,
        httpStatus: 400,
        errors: [{ code: "OTP_INVALID", message: "OTP rejected by the mock portal" }],
        errorClass: "validation",
      };
    }
    return this.issue(p.csrBase64, "TSTZATCA-Code-Signing");
  }

  async complianceCheck(
    p: SubmissionPayload,
    creds: TransportCreds,
  ): Promise<ComplianceCheckResult> {
    this.gate();
    const invalid = this.validate(p);
    const xml = Buffer.from(p.invoice, "base64").toString("utf8");
    // the mock mirrors the platform's hard requirements, not a rubber stamp
    const missing: string[] = [];
    if (!xml.includes("<cbc:ProfileID>reporting:1.0</cbc:ProfileID>")) missing.push("BR-KSA-EN16931-01");
    if (!xml.includes("<ds:SignatureValue>")) missing.push("BR-KSA-60");
    if (!/<cbc:ID>ICV<\/cbc:ID>/.test(xml)) missing.push("BR-KSA-33");
    if (!/<cbc:ID>PIH<\/cbc:ID>/.test(xml)) missing.push("BR-KSA-61");
    if (!/<cac:Delivery>\s*<cbc:ActualDeliveryDate>/.test(xml)) missing.push("BR-KSA-15");
    if (!/<cbc:PaymentMeansCode>(10|30|42|48|1)<\/cbc:PaymentMeansCode>/.test(xml)) missing.push("BR-KSA-16");
    if (!creds.binarySecurityToken.startsWith("MII")) missing.push("CSID_INVALID");
    if (invalid || missing.length > 0) {
      return {
        ok: false,
        validationStatus: "FAIL",
        warnings: [],
        errors: [
          { type: "ERROR", code: "MOCK_COMPLIANCE", message: invalid ?? missing.join(",") },
        ],
        httpStatus: 200,
        raw: { mock: true },
        errorClass: "validation",
      };
    }
    return {
      ok: true,
      validationStatus: "PASS",
      status: "ACCEPTED",
      warnings: [],
      errors: [],
      httpStatus: 200,
      raw: { mock: true, validationResults: { status: "PASS" } },
    };
  }

  async requestProductionCsid(
    complianceRequestId: string,
    creds: TransportCreds,
  ): Promise<CsidResult> {
    this.gate();
    if (!complianceRequestId) {
      return {
        ok: false,
        httpStatus: 400,
        errors: [{ code: "MISSING_REQUEST_ID", message: "compliance_request_id is required" }],
        errorClass: "validation",
      };
    }
    // Both CSIDs certify the same EGS key: without a CA key the mock cannot mint
    // a second certificate, so it re-issues the authenticated one under the
    // production label with a distinct secret.
    if (!creds.binarySecurityToken.startsWith("MII")) {
      return {
        ok: false,
        httpStatus: 401,
        errors: [{ code: "CSID_INVALID", message: "compliance CSID missing" }],
        errorClass: "auth",
      };
    }
    return {
      ok: true,
      binarySecurityToken: creds.binarySecurityToken,
      secret: `mock-production-${Date.now()}`,
      requestId: complianceRequestId,
      dispositionMessage: "ISSUED (mock)",
      httpStatus: 200,
      raw: { mock: true, requestID: complianceRequestId },
    };
  }

  async renewProductionCsid(currentCsid: string, creds: TransportCreds): Promise<CsidResult> {
    this.gate();
    if (currentCsid && currentCsid !== creds.binarySecurityToken) {
      return {
        ok: false,
        httpStatus: 400,
        errors: [{ code: "CSID_MISMATCH", message: "csid does not match the authenticated certificate" }],
        errorClass: "validation",
      };
    }
    return {
      ok: true,
      binarySecurityToken: creds.binarySecurityToken,
      secret: `mock-renewed-${Date.now()}`,
      requestId: `renew-${Date.now()}`,
      dispositionMessage: "RENEWED (mock)",
      httpStatus: 200,
      raw: { mock: true },
    };
  }

  /**
   * The mock portal cannot sign the submitted CSR (no CA key), so it mirrors the
   * CSR's subject/alt-names onto a key pair it certifies itself and hands that
   * key back (`devicePrivateKeyPem`) — the invoice chain then runs on genuine
   * cryptography instead of fake tokens. Production ZATCA returns only the CSID,
   * and the caller keeps the private key it generated locally.
   */
  private async issue(csrBase64: string, fallbackIssuer: string): Promise<CsidResult> {
    const der = Buffer.from(csrBase64, "base64");
    const { inspectCsr, generateCsr } = await import("./csr");
    const { issueLocalCertificate } = await import("./local-ca");
    let info: ReturnType<typeof inspectCsr>;
    try {
      info = inspectCsr(der);
    } catch (e) {
      return {
        ok: false,
        httpStatus: 400,
        errors: [{ code: "CSR_INVALID", message: e instanceof Error ? e.message : "invalid CSR" }],
        errorClass: "validation",
      };
    }
    const env = info.templateName?.startsWith("PRE")
      ? "simulation"
      : info.templateName?.startsWith("ZATCA")
        ? "core"
        : "developer-portal";
    const rebuilt = generateCsr({
      env: env as "developer-portal" | "simulation" | "core",
      egsSerialNumber: info.altNames["2.5.4.4"] ?? "1-Mock|2-Mock|3-mock",
      vatNumber: info.altNames["0.9.2342.19200300.100.1.1"] ?? "311111111101113",
      organizationName: info.organizationName ?? "3111111111",
      organizationalUnitName: info.organizationalUnitName ?? "31111111111",
      commonName: info.commonName ?? undefined,
      registeredAddress: info.altNames["2.5.4.26"] ?? "Riyadh",
      businessCategory: info.altNames["2.5.4.15"] ?? "General",
      invoiceType: info.altNames["2.5.4.12"] ?? "1100",
    });
    const issued = issueLocalCertificate({
      privateKeyPem: rebuilt.privateKeyPem,
      csrDer: rebuilt.csrDer,
      issuerCommonName: info.templateName ?? fallbackIssuer,
    });
    return {
      ok: true,
      binarySecurityToken: issued.certificateBase64,
      secret: Buffer.from(`mock-secret-${issued.serial}`).toString("base64"),
      requestId: issued.requestId,
      dispositionMessage: "ISSUED (mock)",
      httpStatus: 200,
      raw: { mock: true, requestID: issued.requestId },
      devicePrivateKeyPem: rebuilt.privateKeyPem,
    };
  }

  async reportSimplified(p: SubmissionPayload, creds: TransportCreds): Promise<TransportOutcome> {
    this.gate();
    const invalid = this.validate(p);
    if (invalid) {
      return {
        kind: "rejected",
        status: "NOT_REPORTED",
        validationStatus: "FAIL",
        warnings: [],
        errors: [{ type: "ERROR", code: "MOCK_VALIDATION", message: invalid }],
        httpStatus: 200,
        raw: { mock: true },
      };
    }
    return {
      kind: "accepted",
      status: "REPORTED",
      validationStatus: "PASS",
      warnings: [],
      errors: [],
      httpStatus: 200,
      raw: { mock: true, reportingStatus: "REPORTED", credsPresent: Boolean(creds.binarySecurityToken) },
    };
  }

  async clearStandard(p: SubmissionPayload, creds: TransportCreds): Promise<TransportOutcome> {
    this.gate();
    const invalid = this.validate(p);
    if (invalid) {
      return {
        kind: "rejected",
        status: "REJECTED",
        validationStatus: "FAIL",
        warnings: [],
        errors: [{ type: "ERROR", code: "MOCK_VALIDATION", message: invalid }],
        httpStatus: 200,
        raw: { mock: true },
      };
    }
    const xml = Buffer.from(p.invoice, "base64").toString("utf8");
    // ZATCA-side stamping is platform-only; mock returns the payload UNCHANGED (label!)
    return {
      kind: "accepted",
      status: "CLEARED",
      clearedInvoiceB64: Buffer.from(xml).toString("base64"),
      validationStatus: "PASS",
      warnings: [],
      errors: [],
      httpStatus: 200,
      raw: { mock: true, clearanceStatus: "CLEARED", credsPresent: Boolean(creds.binarySecurityToken) },
    };
  }
}

/** Choose the transport per environment config (never accidentally mock). */
export function transportFor(env: string, baseUrlOverride?: string): ZatcaTransport {
  if (process.env.ZATCA_TRANSPORT === "mock") return new MockTransport();
  const base = baseUrlOverride ?? ZATCA_BASE_URLS[env];
  if (!base) throw errors.configuration("errors.zatcaEnvInvalid", env);
  return new HttpTransport(base);
}

export { isDomainError };
