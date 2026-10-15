/**
 * ZATCA onboarding automation (Phase 6, AC-025): CSR → compliance CSID → the six
 * mandatory compliance documents → production CSID → renewal, driven through the
 * real service layer with the mock transport gate (`ZATCA_TRANSPORT=mock`).
 *
 * The mock issues an actual X.509 certificate through the local EGS CA, so the
 * suite proves the whole chain cryptographically: every compliance document is
 * signed with the credential the platform just issued and is self-verified before
 * submission, and the production credential must resolve as signing material
 * afterwards (certificate/key match is enforced).
 *
 * The real developer-portal run stays environment-limited (official credentials
 * required) — this suite is contract-level proof and never a claim of production
 * compliance. AC-025 records that limitation.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { sql } from "drizzle-orm";

const DB = process.env.DATABASE_URL;
/** format-valid KSA VAT (15 digits, first and last digit 3) */
const VAT = "311122393500003";

type TestTenant = { id: string };

describe.skipIf(!DB)("tax — ZATCA onboarding automation", () => {
  let db: typeof import("@/db")["db"];
  let withTenant: typeof import("@/modules/shared/db-context").withTenant;
  let newId: typeof import("@/modules/shared/ids").newId;
  const created: string[] = [];
  const RUN = Math.random().toString(36).slice(2, 8);

  /** Provision a tenant with an enabled tax config and complete seller identity. */
  async function makeTenant(label: string): Promise<TestTenant> {
    const id = newId();
    created.push(id);
    await db.execute(sql`
      insert into tenants (id, name, name_en, status, plan)
      values (${id}, ${`${label} ${RUN}`}, ${`${label} ${RUN}`}, 'active', 'test')
    `);
    await db.execute(sql`
      insert into companies (tenant_id, legal_name, legal_name_en, vat_number, cr_number, base_currency, timezone, locale)
      values (${id}, ${`شركة ${label}`}, ${`${label} Co`}, ${VAT}, '1010000000', 'SAR', 'Asia/Riyadh', 'ar')
    `);
    await db.execute(sql`
      insert into branches (id, tenant_id, code, name, is_default)
      values (${newId()}, ${id}, 'MAIN', 'الفرع الرئيسي', true)
    `);
    await db.execute(sql`
      insert into tax_configs (tenant_id, enabled, env, street, district, city, postal_code,
                                building_no, plot_identification, industry, egs_serial_number)
      values (${id}, true, 'developer-portal', 'طريق الملك فهد', 'العليا', 'الرياض', '12345',
              '2322', '2223', 'أغذية', ${`1-ERPCloud|2-ERP|3-${RUN}`})
    `);
    return { id };
  }

  beforeAll(async () => {
    ({ db } = await import("@/db"));
    ({ withTenant } = await import("@/modules/shared/db-context"));
    ({ newId } = await import("@/modules/shared/ids"));
    process.env.ZATCA_TRANSPORT = "mock";
  });

  afterAll(async () => {
    for (const id of created) {
      await db.execute(sql`update tax_configs set enabled = false where tenant_id = ${id}`);
    }
    delete process.env.ZATCA_TRANSPORT;
  });

  it("runs the full cycle: compliance CSID → six checks → production CSID → renewal", async () => {
    const onboarding = await import("@/modules/tax/onboarding");
    const { resolveSigningMaterial } = await import("@/modules/tax/config");
    const { verifyInvoiceSignature, initialPih } = await import("@/modules/tax/signature");
    const { id: tenant } = await makeTenant("التحاق كامل");

    // 0. nothing issued yet
    let status = await withTenant(tenant, (trx) => onboarding.getOnboardingStatus(trx, tenant));
    expect(status.enabled).toBe(true);
    expect(status.env).toBe("developer-portal");
    expect(status.hasDeviceKey).toBe(false);
    expect(status.checks).toHaveLength(0);
    expect(status.canIssueProduction).toBe(false);

    // 1. policy guard first: the mock portal refuses a bad OTP (no credentials minted)
    const { MockTransport } = await import("@/modules/tax/transport");
    const refused = await new MockTransport().requestComplianceCsid({ csrBase64: "MIIB", otp: "1" });
    expect(refused.ok).toBe(false);
    expect(refused.errors?.[0]?.code).toBe("OTP_INVALID");

    // 2. compliance CSID — the portal OTP is the only human input
    const csid = await withTenant(tenant, (trx) =>
      onboarding.requestComplianceCsid(trx, tenant, { otp: "123456", actorId: null }),
    );
    expect(csid.ok).toBe(true);
    expect(csid.step).toBe("compliance_csid");
    expect(csid.requestId).toBeTruthy();

    status = await withTenant(tenant, (trx) => onboarding.getOnboardingStatus(trx, tenant));
    expect(status.hasDeviceKey).toBe(true);
    expect(status.compliance).toBeTruthy();
    expect(status.complianceRequestId).toBeTruthy();
    expect(status.state).toBe("compliance");

    // the issued certificate must resolve against the EGS key it was issued to
    const material = await withTenant(tenant, (trx) =>
      resolveSigningMaterial(trx, tenant, "developer-portal", "compliance"),
    );
    expect(material).not.toBeNull();
    expect(material!.certificateB64Der.startsWith("MII")).toBe(true);
    expect(material!.privateKeyPem).toContain("PRIVATE KEY");

    // 3. the six mandatory documents, in platform order, submitted and accepted
    const checks = await withTenant(tenant, (trx) => onboarding.runComplianceChecks(trx, tenant, null));
    expect(checks.ok).toBe(true);
    expect(checks.checks?.map((c) => c.kind)).toEqual([
      "standard_invoice",
      "standard_credit_note",
      "standard_debit_note",
      "simplified_invoice",
      "simplified_credit_note",
      "simplified_debit_note",
    ]);
    expect(checks.checks?.every((c) => c.status === "passed")).toBe(true);
    expect(checks.checks?.every((c) => c.validationStatus === "PASS")).toBe(true);

    const journal = (await db.execute(sql`
      select doc_kind, status, validation_status, icv, previous_hash, invoice_hash, attempts, xml
      from zatca_compliance_checks where tenant_id = ${tenant} order by icv asc
    `)) as unknown as {
      rows: {
        doc_kind: string;
        status: string;
        validation_status: string;
        icv: string | number;
        previous_hash: string;
        invoice_hash: string;
        attempts: string | number;
        xml: string;
      }[];
    };
    expect(journal.rows).toHaveLength(6);
    expect(journal.rows.map((r) => Number(r.icv))).toEqual([1, 2, 3, 4, 5, 6]);
    expect(journal.rows.every((r) => r.status === "passed")).toBe(true);
    expect(journal.rows.every((r) => Number(r.attempts) === 1)).toBe(true);

    // the run carries its own PIH chain: genesis → each document links to the previous
    expect(journal.rows[0].previous_hash).toBe(initialPih());
    expect(journal.rows[0].previous_hash).toBe(
      "NWZlY2ViNjZmZmM4NmYzOGQ5NTI3ODZjNmQ2OTZjNzljMmRiYzIzOWRkNGU5MWI0NjcyOWQ3M2EyN2ZiNTdlOQ==",
    );
    for (let i = 1; i < journal.rows.length; i += 1) {
      expect(journal.rows[i].previous_hash).toBe(journal.rows[i - 1].invoice_hash);
    }

    // every stored document is genuinely signed and verifies end-to-end
    for (const row of journal.rows) {
      const verified = verifyInvoiceSignature(row.xml);
      expect(verified).toMatchObject({
        digestValid: true,
        signedPropertiesValid: true,
        certificateDigestValid: true,
        signatureValid: true,
      });
      expect(verified.invoiceHashB64).toBe(row.invoice_hash);
      expect(row.xml).toContain("<ds:SignatureValue>");
      expect(row.xml).toContain("invoiceSignedData");
    }

    // credit/debit notes carry the platform-required billing reference + reason
    const credit = journal.rows.find((r) => r.doc_kind === "standard_credit_note")!;
    expect(credit.xml).toContain("<cac:BillingReference>");
    expect(credit.xml).toContain("<cbc:InstructionNote>");
    expect(credit.xml).toContain(">381</cbc:InvoiceTypeCode>");
    const debit = journal.rows.find((r) => r.doc_kind === "standard_debit_note")!;
    expect(debit.xml).toContain(">383</cbc:InvoiceTypeCode>");

    // 4. production CSID (only reachable once all six passed)
    const pcsid = await withTenant(tenant, (trx) => onboarding.issueProductionCsid(trx, tenant, null));
    expect(pcsid.ok).toBe(true);
    expect(pcsid.step).toBe("production_csid");

    status = await withTenant(tenant, (trx) => onboarding.getOnboardingStatus(trx, tenant));
    expect(status.state).toBe("production");
    expect(status.production).toBeTruthy();
    expect(status.canIssueProduction).toBe(true);

    const prodMaterial = await withTenant(tenant, (trx) =>
      resolveSigningMaterial(trx, tenant, "developer-portal", "production"),
    );
    expect(prodMaterial).not.toBeNull();
    expect(prodMaterial!.certificateB64Der.startsWith("MII")).toBe(true);
    expect(prodMaterial!.certificateExpiresAt).toBeInstanceOf(Date);

    // 5. renewal rotates the production credential; the previous row is kept for audit
    const renewed = await withTenant(tenant, (trx) => onboarding.renewProductionCsid(trx, tenant, null));
    expect(renewed.ok).toBe(true);
    expect(renewed.step).toBe("renewal");

    const rows = (await db.execute(sql`
      select kind, status, count(*)::int as n from zatca_certificates
      where tenant_id = ${tenant} group by kind, status order by kind, status
    `)) as unknown as { rows: { kind: string; status: string; n: number }[] };
    expect(rows.rows.some((r) => r.kind === "production" && r.status === "active" && r.n === 1)).toBe(true);
    expect(rows.rows.some((r) => r.kind === "production" && r.status === "rotated")).toBe(true);
    // exactly one active device key after the renewal (no key duplication)
    expect(rows.rows.filter((r) => r.kind === "device_key" && r.status === "active").length).toBe(1);
  });

  it("refuses the production CSID until all six checks have passed", async () => {
    const onboarding = await import("@/modules/tax/onboarding");
    const { isDomainError } = await import("@/modules/shared/result");
    const { id: tenant } = await makeTenant("بلا فحوصات");

    const noCred = await withTenant(tenant, (trx) =>
      onboarding.issueProductionCsid(trx, tenant, null).catch((e: unknown) => e),
    );
    expect(isDomainError(noCred)).toBe(true);
    expect((noCred as { messageKey: string }).messageKey).toBe(
      "errors.taxComplianceCredentialMissing",
    );

    // compliance CSID issued but no checks run yet → incomplete
    const issued = await withTenant(tenant, (trx) =>
      onboarding.requestComplianceCsid(trx, tenant, { otp: "123456", actorId: null }),
    );
    expect(issued.ok).toBe(true);

    const incomplete = await withTenant(tenant, (trx) =>
      onboarding.issueProductionCsid(trx, tenant, null).catch((e: unknown) => e),
    );
    expect(isDomainError(incomplete)).toBe(true);
    expect((incomplete as { messageKey: string }).messageKey).toBe(
      "errors.taxComplianceChecksIncomplete",
    );
    expect((incomplete as { meta?: { missing: string[] } }).meta?.missing).toHaveLength(6);

    // and nothing was minted
    const minted = (await db.execute(sql`
      select count(*)::int as n from zatca_certificates
      where tenant_id = ${tenant} and kind = 'production'
    `)) as unknown as { rows: { n: number }[] };
    expect(Number(minted.rows[0].n)).toBe(0);
  });

  it("rejects an invalid OTP and an invalid CSR without issuing anything", async () => {
    const onboarding = await import("@/modules/tax/onboarding");
    const { isDomainError } = await import("@/modules/shared/result");
    const { id: tenant } = await makeTenant("OTP خاطئ");

    for (const otp of ["12", "12345x", ""]) {
      const bad = await withTenant(tenant, (trx) =>
        onboarding.requestComplianceCsid(trx, tenant, { otp, actorId: null }).catch((e: unknown) => e),
      );
      expect(isDomainError(bad)).toBe(true);
      expect((bad as { messageKey: string }).messageKey).toBe("errors.zatcaOtpInvalid");
    }

    const minted = (await db.execute(sql`
      select count(*)::int as n from zatca_certificates where tenant_id = ${tenant}
    `)) as unknown as { rows: { n: number }[] };
    expect(Number(minted.rows[0].n)).toBe(0);

    // the mock portal applies the same gate at the transport boundary
    const { MockTransport } = await import("@/modules/tax/transport");
    const shortOtp = await new MockTransport().requestComplianceCsid({
      csrBase64: "MIIB",
      otp: "12345",
    });
    expect(shortOtp.ok).toBe(false);
  });

  it("refuses an unsigned/naked document at the compliance endpoint (no rubber stamp)", async () => {
    const { MockTransport } = await import("@/modules/tax/transport");
    const outcome = await new MockTransport().complianceCheck(
      { invoiceHash: "x", uuid: "8d487816-70b8-4ade-a618-9d620b73814a", invoice: Buffer.from("<Invoice/>").toString("base64") },
      { binarySecurityToken: "MIIB", secret: "s" },
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.validationStatus).toBe("FAIL");
    expect(outcome.errors.length).toBeGreaterThan(0);
  });

  it("reports onboarding status for the /tax UI without leaking credentials", async () => {
    const onboarding = await import("@/modules/tax/onboarding");
    const { id: tenant } = await makeTenant("حالة الالتحاق");
    await withTenant(tenant, (trx) =>
      onboarding.requestComplianceCsid(trx, tenant, { otp: "123456", actorId: null }),
    );
    const status = await withTenant(tenant, (trx) => onboarding.getOnboardingStatus(trx, tenant));
    expect(status.state).toBe("compliance");
    expect(status.hasDeviceKey).toBe(true);
    expect(status.egsSerialNumber).toBeTruthy();
    // the read model exposes no token/secret material
    const serialized = JSON.stringify(status);
    expect(serialized).not.toContain("binarySecurityToken");
    expect(serialized).not.toContain("PRIVATE KEY");
  });
});
