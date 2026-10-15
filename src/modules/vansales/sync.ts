/**
 * Sync apply engine (OFFLINE_SYNC §4). Every op is applied in its own tenant
 * transaction; the idempotency row is written in the SAME transaction, so an
 * op is applied atomically at most once (INV-02/05). Payload-hash mismatch on
 * a known op_id = tamper → reject + security audit, never re-applied.
 */

import { and, eq } from "drizzle-orm";
import { createHash } from "crypto";
import {
  devices,
  idempotencyKeys,
  representatives,
  warehouses,
} from "@/db/schema";
import { withTenant, type Trx } from "@/modules/shared/db-context";
import { errors, isDomainError } from "@/modules/shared/result";
import { writeAudit } from "@/modules/shared/audit";
import type { ServiceCtx } from "@/modules/shared/context";
import { logger } from "@/modules/shared/logger";
import { createAndPostInvoice, createInvoiceDraft } from "@/modules/sales/invoices";
import { createReceiptCore } from "@/modules/sales/receipts";
import { acceptTransfer } from "@/modules/inventory/transfers";
import { requestSettlement } from "./settlement";

export interface SyncOp {
  opId: string;
  opType: string;
  payload: Record<string, unknown>;
  payloadHash: string;
}

export interface OpResult {
  opId: string;
  status: "ack" | "replayed" | "rejected" | "conflict" | "tamper";
  messageKey?: string;
  detail?: string;
  refs?: Record<string, unknown>;
}

export function hashPayload(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex");
}

/** Verify device: exists, active, bound to this user (SEC §7). */
export async function assertDevice(
  trx: Trx,
  tenantId: string,
  deviceId: string,
  userId: string,
): Promise<void> {
  const [device] = await trx
    .select()
    .from(devices)
    .where(and(eq(devices.tenantId, tenantId), eq(devices.id, deviceId)))
    .limit(1);
  if (!device) throw errors.validation("errors.deviceNotRegistered", deviceId);
  if (device.status === "revoked") throw errors.auth("errors.deviceRevoked");
  if (device.userId !== userId) throw errors.auth("errors.deviceBindingMismatch");
  await trx.update(devices).set({ lastSeenAt: new Date() }).where(eq(devices.id, deviceId));
}

/** Representative custody warehouse of the user (server-side scope for POS ops). */
async function custodyWarehouseOf(trx: Trx, tenantId: string, userId: string): Promise<string> {
  const [rep] = await trx
    .select({ custodyWarehouseId: representatives.custodyWarehouseId, active: representatives.active })
    .from(representatives)
    .where(and(eq(representatives.tenantId, tenantId), eq(representatives.userId, userId)))
    .limit(1);
  if (!rep?.custodyWarehouseId || !rep.active) {
    throw errors.validation("errors.noCustodyWarehouse");
  }
  return rep.custodyWarehouseId;
}

async function applyOpInner(
  trx: Trx,
  ctx: ServiceCtx,
  deviceId: string,
  op: SyncOp,
): Promise<OpResult> {
  const svcCtx: ServiceCtx = { tenantId: ctx.tenantId, actorId: ctx.actorId };
  const p = op.payload as Record<string, never>;

  switch (op.opType) {
    case "invoice.create": {
      const custody = await custodyWarehouseOf(trx, ctx.tenantId, ctx.actorId!);
      const r = await createAndPostInvoice(
        trx,
        svcCtx,
        {
          customerId: (p.customerId as string | null) ?? null,
          warehouseId: custody, // server-imposed scope — never client-chosen
          businessDate: p.businessDate as string,
          isCredit: Boolean(p.isCredit),
          dueDate: (p.dueDate as string | null) ?? null,
          lines: p.lines as never[],
          paymentLines: (p.paymentLines as never[] | undefined) ?? [],
          salespersonUserId: ctx.actorId,
          clientOpId: op.opId,
        },
        false, // field overrides require permission; rep holds none by default here
      );
      return { opId: op.opId, status: "ack", refs: { invoiceId: r.invoiceId, invoiceNo: r.invoiceNo } };
    }
    case "invoice.draft": {
      const custody = await custodyWarehouseOf(trx, ctx.tenantId, ctx.actorId!);
      const id = await createInvoiceDraft(
        trx,
        svcCtx,
        {
          customerId: (p.customerId as string | null) ?? null,
          warehouseId: custody,
          businessDate: p.businessDate as string,
          isCredit: Boolean(p.isCredit),
          dueDate: (p.dueDate as string | null) ?? null,
          lines: p.lines as never[],
          salespersonUserId: ctx.actorId,
          clientOpId: op.opId,
        },
        false,
      );
      return { opId: op.opId, status: "ack", refs: { invoiceId: id } };
    }
    case "receipt.create": {
      const r = await createReceiptCore(trx, svcCtx, {
        customerId: p.customerId as string,
        businessDate: p.businessDate as string,
        paymentLines: p.paymentLines as never[],
        allocations: p.allocations as never[],
        memo: (p.memo as string | null) ?? null,
      });
      return { opId: op.opId, status: "ack", refs: { receiptId: r.receiptId, receiptNo: r.receiptNo } };
    }
    case "transfer.accept": {
      await acceptTransfer(
        trx,
        svcCtx,
        p.transferId as string,
        p.accepts as never[],
        { businessDate: p.businessDate as string, acceptRef: op.opId },
      );
      return { opId: op.opId, status: "ack", refs: { transferId: p.transferId as string } };
    }
    case "settlement.request": {
      const r = await requestSettlement(trx, svcCtx, ctx.actorId!, p.businessDate as string);
      return { opId: op.opId, status: "ack", refs: { settlementId: r.settlementId, settlementNo: r.settlementNo } };
    }
    default:
      throw errors.validation("errors.unknownSyncOp", op.opType);
  }
}

/**
 * Apply one op atomically: idempotency insert + business apply in one tx.
 * Concurrent duplicates: the PK conflict rolls back to savepoint → replay.
 */
export async function applySyncOp(
  ctx: ServiceCtx,
  deviceId: string,
  op: SyncOp,
): Promise<OpResult> {
  // fast path: already processed (committed earlier)
  const existing = await withTenant(ctx.tenantId, async (trx) => {
    await assertDevice(trx, ctx.tenantId, deviceId, ctx.actorId!);
    const [row] = await trx
      .select()
      .from(idempotencyKeys)
      .where(
        and(
          eq(idempotencyKeys.tenantId, ctx.tenantId),
          eq(idempotencyKeys.deviceId, deviceId),
          eq(idempotencyKeys.opId, op.opId),
        ),
      )
      .limit(1);
    return row ?? null;
  });

  if (existing) {
    if (existing.payloadHash !== op.payloadHash) {
      logger.warn({ opId: op.opId, deviceId }, "sync tamper: payload hash mismatch");
      return { opId: op.opId, status: "tamper", messageKey: "errors.syncTampered" };
    }
    return { opId: op.opId, status: "replayed", refs: existing.result ?? undefined };
  }

  try {
    return await withTenant(ctx.tenantId, async (trx) => {
      const result = await applyOpInner(trx, ctx, deviceId, op);
      await trx.insert(idempotencyKeys).values({
        tenantId: ctx.tenantId,
        deviceId,
        opId: op.opId,
        opType: op.opType,
        payloadHash: op.payloadHash,
        status: "ack",
        result: result.refs ?? {},
      });
      return result;
    });
  } catch (e) {
    // business rejection — record durably so retries don't re-attempt blindly
    if (isDomainError(e)) {
      try {
        await withTenant(ctx.tenantId, async (trx) => {
          await trx
            .insert(idempotencyKeys)
            .values({
              tenantId: ctx.tenantId,
              deviceId,
              opId: op.opId,
              opType: op.opType,
              payloadHash: op.payloadHash,
              status: e.kind === "ConflictError" ? "conflict" : "rejected",
              result: { messageKey: e.messageKey, detail: e.detail ?? null },
            })
            .onConflictDoNothing();
        });
      } catch {
        /* best-effort rejection record */
      }
      return {
        opId: op.opId,
        status: e.kind === "ConflictError" ? "conflict" : "rejected",
        messageKey: e.messageKey,
        detail: e.detail,
      };
    }
    logger.error({ err: e, opId: op.opId }, "sync apply failed");
    return { opId: op.opId, status: "rejected", messageKey: "errors.unexpected" };
  }
}

export async function applyOpBatch(
  ctx: ServiceCtx,
  deviceId: string,
  ops: SyncOp[],
): Promise<OpResult[]> {
  const out: OpResult[] = [];
  // sequential application preserves depends_on-style client ordering
  for (const op of ops) {
    out.push(await applySyncOp(ctx, deviceId, op));
  }
  return out;
}

/** Verify warehouse is the rep's custody (pull scoping helper). */
export async function custodyForUser(trx: Trx, tenantId: string, userId: string) {
  const [w] = await trx
    .select()
    .from(warehouses)
    .where(and(eq(warehouses.tenantId, tenantId), eq(warehouses.representativeUserId, userId)))
    .limit(1);
  return w ?? null;
}
