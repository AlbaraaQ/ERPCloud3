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

export interface ZatcaTransport {
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
