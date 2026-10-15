/**
 * Submission processor: transport boundary + status machine transitions.
 * Never fabricates; every attempt journaled (response, classification).
 */

import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import {
  invoiceSubmissions,
  salesInvoices,
  zatcaCertificates,
  taxConfigs,
} from "@/db/schema";
import { errors } from "@/modules/shared/result";
import { b64 } from "./crypto";
import { transportFor, type TransportOutcome } from "./transport";
import { writeAudit } from "@/modules/shared/audit";
import { logger } from "@/modules/shared/logger";



export interface ProcessResult {
  submissionId: string;
  outcome: "reported" | "cleared" | "rejected" | "failed_retryable" | "blocked_config";
}

async function processOne(
  sub: typeof invoiceSubmissions.$inferSelect,
  tenantId: string,
): Promise<ProcessResult> {
  const [cfg] = await db.select().from(taxConfigs).where(eq(taxConfigs.tenantId, tenantId)).limit(1);
  if (!cfg?.enabled) return { submissionId: sub.id, outcome: "blocked_config" };

  const [creds] = await db
    .select()
    .from(zatcaCertificates)
    .where(
      and(
        eq(zatcaCertificates.tenantId, tenantId),
        eq(zatcaCertificates.env, cfg.env),
        eq(zatcaCertificates.kind, "production"),
        eq(zatcaCertificates.status, "active"),
      ),
    )
    .limit(1);
  if (!creds?.binarySecurityToken || !creds.secret) {
    await db.transaction(async (trx) => {
      await trx
        .update(invoiceSubmissions)
        .set({ status: "blocked_config", lastErrorClass: "config", lastError: "production_credential_missing", updatedAt: new Date() })
        .where(eq(invoiceSubmissions.id, sub.id));
      await writeAudit(trx, {
        tenantId,
        actorUserId: null,
        actorLabel: "system/processor",
        action: "tax.submission.blocked_config",
        entity: "invoice_submission",
        entityId: sub.id,
        after: { reason: "production_credential_missing" },
      });
    });
    return { submissionId: sub.id, outcome: "blocked_config" };
  }

  const transport = transportFor(cfg.env);
  const payload = {
    invoiceHash: sub.invoiceHash,
    uuid: sub.invoiceUuid,
    invoice: b64(sub.xml),
  };

  let outcome: TransportOutcome;
  try {
    outcome =
      sub.docType === "simplified"
        ? await transport.reportSimplified(payload, { binarySecurityToken: creds.binarySecurityToken, secret: creds.secret })
        : await transport.clearStandard(payload, { binarySecurityToken: creds.binarySecurityToken, secret: creds.secret });
  } catch (e) {
    if (isDomainTransportRefusal(e)) throw e; // mock-gate violation = programming error
    logger.error({ err: e, submission: sub.id }, "submission transport threw");
    outcome = { kind: "transport_error", errorClass: "network", errorMessage: String(e), httpStatus: 0, warnings: [], errors: [] };
  }

  const now = new Date();
  const attempts = sub.attempts + 1;

  return db.transaction(async (trx) => {
    if (outcome.kind === "accepted") {
      const accepted = sub.docType === "simplified" ? "reported" : "cleared";
      await trx
        .update(invoiceSubmissions)
        .set({
          status: accepted,
          attempts,
          submittedAt: sub.submittedAt ?? now,
          acceptedAt: now,
          response: outcome.raw ?? { status: outcome.status },
          lastError: null,
          lastErrorClass: null,
          updatedAt: now,
        })
        .where(eq(invoiceSubmissions.id, sub.id));
      await trx
        .update(salesInvoices)
        .set({ taxStatus: accepted })
        .where(eq(salesInvoices.id, sub.invoiceId));
      await writeAudit(trx, {
        tenantId,
        actorUserId: null,
        actorLabel: "system/processor",
        action: `tax.submission.${accepted}`,
        entity: "invoice_submission",
        entityId: sub.id,
        after: { attempts, status: outcome.status, validation: outcome.validationStatus },
      });
      return { submissionId: sub.id, outcome: accepted };
    }

    if (outcome.kind === "rejected") {
      await trx
        .update(invoiceSubmissions)
        .set({
          status: "rejected",
          attempts,
          submittedAt: sub.submittedAt ?? now,
          response: outcome.raw ?? { errors: outcome.errors },
          lastErrorClass: "validation",
          lastError: outcome.errors.map((e) => e.message).join(" | ").slice(0, 900),
          updatedAt: now,
        })
        .where(eq(invoiceSubmissions.id, sub.id));
      await trx
        .update(salesInvoices)
        .set({ taxStatus: "rejected" })
        .where(eq(salesInvoices.id, sub.invoiceId));
      await writeAudit(trx, {
        tenantId,
        actorUserId: null,
        actorLabel: "system/processor",
        action: "tax.submission.rejected",
        entity: "invoice_submission",
        entityId: sub.id,
        after: { attempts, errors: outcome.errors.slice(0, 5) },
      });
      return { submissionId: sub.id, outcome: "rejected" };
    }

    // transport error → retryable (same uuid/icv/xml guaranteed upstream)
    await trx
      .update(invoiceSubmissions)
      .set({
        status: "failed_retryable",
        attempts,
        lastErrorClass: outcome.errorClass ?? "network",
        lastError: (outcome.errorMessage ?? "transport error").slice(0, 900),
        response: outcome.raw ?? null,
        updatedAt: now,
      })
      .where(eq(invoiceSubmissions.id, sub.id));
    await trx
      .update(salesInvoices)
      .set({ taxStatus: "failed_retryable" })
      .where(eq(salesInvoices.id, sub.invoiceId));
    await writeAudit(trx, {
      tenantId,
      actorUserId: null,
      actorLabel: "system/processor",
      action: "tax.submission.transport_error",
      entity: "invoice_submission",
      entityId: sub.id,
      after: { attempts, errorClass: outcome.errorClass },
    });
    return { submissionId: sub.id, outcome: "failed_retryable" };
  });
}

function isDomainTransportRefusal(e: unknown): boolean {
  return e instanceof Error && e.name === "InvariantViolation";
}

/** Worker-facing batch: process pending/failed submissions (oldest first). */
export async function processPendingSubmissions(limit = 20): Promise<ProcessResult[]> {
  const rows = await db
    .select()
    .from(invoiceSubmissions)
    .where(
      inArray(invoiceSubmissions.status, [
        "issued_pending_reporting",
        "clearance_pending",
        "failed_retryable",
      ]),
    )
    .orderBy(invoiceSubmissions.createdAt)
    .limit(limit);
  const results: ProcessResult[] = [];
  for (const sub of rows) {
    // skip unsigned (blocked_config gets set only when signature missing)
    if (!sub.signatureValue || !sub.qrBase64) {
      await db
        .update(invoiceSubmissions)
        .set({ status: "blocked_config", updatedAt: new Date() })
        .where(eq(invoiceSubmissions.id, sub.id));
      results.push({ submissionId: sub.id, outcome: "blocked_config" });
      continue;
    }
    results.push(await processOne(sub, sub.tenantId));
  }
  return results;
}

/** Manual retry of one submission (failed_retryable only; rejected needs correction). */
export async function retrySubmission(tenantId: string, submissionId: string, byUserId: string | null): Promise<void> {
  await db.transaction(async (trx) => {
    const [sub] = await trx
      .select()
      .from(invoiceSubmissions)
      .where(and(eq(invoiceSubmissions.tenantId, tenantId), eq(invoiceSubmissions.id, submissionId)))
      .for("update")
      .limit(1);
    if (!sub) throw errors.notFound("invoiceSubmission", submissionId);
    if (sub.status !== "failed_retryable") {
      throw errors.validation("errors.submissionNotRetryable", undefined, { status: sub.status });
    }
    await trx
      .update(invoiceSubmissions)
      .set({
        status: sub.docType === "simplified" ? "issued_pending_reporting" : "clearance_pending",
        updatedAt: new Date(),
      })
      .where(eq(invoiceSubmissions.id, sub.id));
    await writeAudit(trx, {
      tenantId,
      actorUserId: byUserId,
      actorLabel: byUserId ?? "system",
      action: "tax.submission.retry_requested",
      entity: "invoice_submission",
      entityId: submissionId,
    });
  });
}
