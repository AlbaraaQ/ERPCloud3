/**
 * Approval tickets — the decision core (AI_ASSISTANT §4).
 *
 * Kept out of the server-action file on purpose: the state machine and its
 * permission check are the part that must be *testable* (and re-testable) without
 * a browser session. The action only supplies the session's facts; this module
 * decides and executes.
 *
 * State machine: proposed → approved → executed, or proposed → rejected, or
 * proposed → expired. Nothing else, and no state is skipped.
 */

import { and, eq, lt } from "drizzle-orm";
import { aiApprovalTickets } from "@/db/schema";
import { withTenant, type Trx } from "@/modules/shared/db-context";
import { writeAudit } from "@/modules/shared/audit";
import { logger } from "@/modules/shared/logger";
import { errors, isDomainError } from "@/modules/shared/result";
import { findIntent } from "./intents";

export interface TicketDecisionInput {
  tenantId: string;
  userId: string;
  actorLabel: string;
  /** the APPROVER's permissions, as the session resolved them */
  permissions: ReadonlySet<string>;
  ticketId: string;
  decision: "approve" | "reject";
  note?: string | null;
}

export interface TicketDecisionResult {
  ok: boolean;
  /** i18n key when refused */
  errorKey?: string;
  status?: string;
  /** what the executed intent produced (document id/number), never model text */
  result?: Record<string, unknown>;
}

/**
 * Approve/reject one ticket.
 *
 * Order is deliberate: scope → state → expiry → permission → decision → execution.
 * A caller without the intent's permission changes nothing (not even the note), and
 * an approval is recorded *before* execution so a failure leaves an auditable
 * ticket in `approved`, never a silent nothing.
 */
export async function decideTicket(input: TicketDecisionInput): Promise<TicketDecisionResult> {
  const scope = and(eq(aiApprovalTickets.id, input.ticketId), eq(aiApprovalTickets.tenantId, input.tenantId));

  const [ticket] = await withTenant(input.tenantId, (trx: Trx) =>
    trx.select().from(aiApprovalTickets).where(scope).limit(1),
  );
  if (!ticket) return { ok: false, errorKey: "errors.aiTicketNotFound" };
  if (ticket.status !== "proposed" && ticket.status !== "approved") {
    return { ok: false, errorKey: "errors.aiTicketDecided", status: ticket.status };
  }
  if (ticket.expiresAt.getTime() < Date.now()) {
    await withTenant(input.tenantId, (trx: Trx) =>
      trx.update(aiApprovalTickets).set({ status: "expired" }).where(scope),
    );
    return { ok: false, errorKey: "errors.aiTicketExpired", status: "expired" };
  }

  // proposing is not approving: the approver must hold the intent's permission
  if (!input.permissions.has(ticket.requiredPermission)) {
    return { ok: false, errorKey: "errors.permissionDenied", status: ticket.status };
  }

  if (input.decision === "reject") {
    await withTenant(input.tenantId, async (trx: Trx) => {
      await trx
        .update(aiApprovalTickets)
        .set({
          status: "rejected",
          decidedByUserId: input.userId,
          decidedAt: new Date(),
          decisionNote: input.note ?? null,
        })
        .where(scope);
      await writeAudit(trx, {
        tenantId: input.tenantId,
        actorUserId: input.userId,
        actorLabel: input.actorLabel,
        action: "ai.ticket.rejected",
        entity: "ai_approval_ticket",
        entityId: input.ticketId,
        after: { intent: ticket.intent, note: input.note ?? null },
      });
    });
    return { ok: true, status: "rejected" };
  }

  await withTenant(input.tenantId, async (trx: Trx) => {
    await trx
      .update(aiApprovalTickets)
      .set({
        status: "approved",
        decidedByUserId: input.userId,
        decidedAt: new Date(),
        decisionNote: input.note ?? null,
      })
      .where(scope);
    await writeAudit(trx, {
      tenantId: input.tenantId,
      actorUserId: input.userId,
      actorLabel: input.actorLabel,
      action: "ai.ticket.approved",
      entity: "ai_approval_ticket",
      entityId: input.ticketId,
      after: { intent: ticket.intent, requiredPermission: ticket.requiredPermission },
    });
  });

  const intent = findIntent(ticket.intent);
  if (!intent) return { ok: false, errorKey: "errors.aiTicketUnknownIntent", status: "approved" };
  const parsed = intent.schema.safeParse(ticket.payload ?? {});
  if (!parsed.success) return { ok: false, errorKey: "errors.aiTicketPayloadInvalid", status: "approved" };

  let execution;
  try {
    // runs OUTSIDE the transactions above: the intent opens its own unit of work
    // (the export builder uses the pool directly), so no transaction nests here
    execution = await intent.execute(
      { tenantId: input.tenantId, userId: input.userId, actorLabel: input.actorLabel },
      parsed.data as Record<string, unknown>,
    );
  } catch (e) {
    const key = isDomainError(e) ? e.messageKey : "errors.unexpected";
    logger.warn({ err: e, ticketId: input.ticketId, intent: ticket.intent }, "approved ticket failed to execute");
    await withTenant(input.tenantId, (trx: Trx) =>
      trx.update(aiApprovalTickets).set({ result: { ok: false, errorKey: key } }).where(scope),
    );
    return { ok: false, errorKey: key, status: "approved" };
  }

  await withTenant(input.tenantId, async (trx: Trx) => {
    await trx
      .update(aiApprovalTickets)
      .set({
        status: "executed",
        executedAt: new Date(),
        executedByUserId: input.userId,
        result: { ok: true, ...execution.result },
      })
      .where(scope);
    await writeAudit(trx, {
      tenantId: input.tenantId,
      actorUserId: input.userId,
      actorLabel: input.actorLabel,
      action: execution.auditAction,
      entity: execution.auditEntity,
      entityId: execution.auditEntityId,
      after: { ticketId: input.ticketId, intent: ticket.intent, ...execution.result },
    });
  });

  return { ok: true, status: "executed", result: execution.result };
}

/** Sweep proposals whose expiry passed. Returns how many were closed. */
export async function expireTickets(tenantId: string): Promise<number> {
  const rows = await withTenant(tenantId, (trx: Trx) =>
    trx
      .update(aiApprovalTickets)
      .set({ status: "expired" })
      .where(
        and(
          eq(aiApprovalTickets.tenantId, tenantId),
          eq(aiApprovalTickets.status, "proposed"),
          lt(aiApprovalTickets.expiresAt, new Date()),
        ),
      )
      .returning({ id: aiApprovalTickets.id }),
  );
  return rows.length;
}
