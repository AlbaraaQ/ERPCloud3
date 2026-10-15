/**
 * Test helper: issue a REAL EGS credential pair for the local sandbox.
 *
 * The integration suites exercise the production signing path, which requires a
 * certificate whose public key matches the stored device key. Instead of
 * pasting an opaque token, the helper runs the same cryptography as the mock
 * onboarding path: generate CSR → local EGS CA issues a self-signed X.509 →
 * store key + certificate. Signatures produced by the app are therefore
 * genuinely verifiable (no fake tokens anywhere).
 */

import { sql } from "drizzle-orm";
import { generateCsr } from "@/modules/tax/csr";
import { issueLocalCertificate } from "@/modules/tax/local-ca";
import { newId } from "@/modules/shared/ids";

export interface TestCsid {
  deviceKeyId: string;
  certificateBase64: string;
  privateKeyPem: string;
  publicKeySpkiPem: string;
  requestId: string;
  serial: string;
}

export function mintLocalCsid(input: {
  vatNumber: string;
  organizationName: string;
  organizationalUnitName: string;
  env?: "developer-portal" | "simulation" | "core";
  serial?: string;
}): TestCsid {
  const env = input.env ?? "developer-portal";
  const csr = generateCsr({
    env,
    egsSerialNumber: input.serial ?? `1-HiSab|2-Test|3-${newId().slice(0, 12)}`,
    vatNumber: input.vatNumber,
    organizationName: input.organizationName,
    organizationalUnitName: input.organizationalUnitName,
    registeredAddress: "Riyadh",
    businessCategory: "Testing",
    invoiceType: "1100",
  });
  const issued = issueLocalCertificate({
    privateKeyPem: csr.privateKeyPem,
    csrDer: csr.csrDer,
    issuerCommonName: csr.templateName,
  });
  return {
    deviceKeyId: newId(),
    certificateBase64: issued.certificateBase64,
    privateKeyPem: csr.privateKeyPem,
    publicKeySpkiPem: csr.publicKeySpkiPem,
    requestId: issued.requestId,
    serial: issued.serial,
  };
}

type Db = typeof import("@/db")["db"];

/** Store the credential as the tenant's active device key + production CSID. */
export async function seedTestCredential(
  db: Db,
  tenantId: string,
  env: string,
  cred: TestCsid,
): Promise<void> {
  await db.execute(sql`
    update zatca_certificates set status = 'rotated'
    where tenant_id = ${tenantId} and env = ${env} and kind in ('device_key', 'production')
  `);
  await db.execute(sql`
    insert into zatca_certificates (id, tenant_id, env, kind, label, private_key, public_key, status)
    values (${cred.deviceKeyId}, ${tenantId}, ${env}, 'device_key', 'test-egs', ${cred.privateKeyPem}, ${cred.publicKeySpkiPem}, 'active')
  `);
  await db.execute(sql`
    insert into zatca_certificates (id, tenant_id, env, kind, label, binary_security_token, secret, request_id, device_key_id, status)
    values (${newId()}, ${tenantId}, ${env}, 'production', 'test-pcsid', ${cred.certificateBase64}, 'test-secret', ${cred.requestId}, ${cred.deviceKeyId}, 'active')
  `);
}
