/**
 * Transfer engine (INVENTORY_AND_COSTING §5, VAN_SALES_WORKFLOW §3).
 * Dispatch locks source stock into the tenant's virtual in-transit warehouse
 * and moves cost with it; acceptance moves it to the destination. Partial
 * receipts and disputes are explicit; double receipt impossible (INV-07).
 */

import { and, eq, sql } from "drizzle-orm";
import {
  transfers,
  transferLines,
  warehouses,
  notifications,
} from "@/db/schema";
import type { Trx } from "@/modules/shared/db-context";
import { errors } from "@/modules/shared/result";
import { dec, toDb, Decimal } from "@/modules/shared/money";
import { newId } from "@/modules/shared/ids";
import { writeAudit } from "@/modules/shared/audit";
import type { ServiceCtx } from "@/modules/shared/context";
import { recordMovement } from "./stock";
import { nextDocNumber } from "@/modules/accounting/posting";

export interface TransferLineInput {
  productId: string;
  qty: string;
  lotId?: string | null;
}

export interface AcceptInput {
  lineId: string;
  qty: string;
  discrepancyReason?: string | null;
}

export interface AcceptOptions {
  businessDate: string;
  /** caller-supplied idempotency ref per accept call (sync-op key later). */
  acceptRef: string;
}

type TransferRow = typeof transfers.$inferSelect;

async function lockTransfer(trx: Trx, tenantId: string, transferId: string): Promise<TransferRow> {
  // drizzle .for("update") keeps camelCase typing (raw "select *" returns snake_case)
  const [t] = await trx
    .select()
    .from(transfers)
    .where(and(eq(transfers.tenantId, tenantId), eq(transfers.id, transferId)))
    .for("update")
    .limit(1);
  if (!t) throw errors.notFound("transfer", transferId);
  return t;
}

async function inTransitWarehouseId(trx: Trx, tenantId: string): Promise<string> {
  const [w] = await trx
    .select({ id: warehouses.id })
    .from(warehouses)
    .where(and(eq(warehouses.tenantId, tenantId), eq(warehouses.type, "in_transit")))
    .limit(1);
  if (!w) throw errors.configuration("errors.noInTransitWarehouse");
  return w.id;
}

/** Create a draft transfer (no stock effects yet). */
export async function createTransferDraft(
  trx: Trx,
  ctx: ServiceCtx,
  input: {
    fromWarehouseId: string;
    toWarehouseId: string;
    businessDate: string;
    lines: TransferLineInput[];
  },
): Promise<string> {
  if (input.fromWarehouseId === input.toWarehouseId) {
    throw errors.validation("errors.transferSameWarehouse");
  }
  if (input.lines.length === 0) throw errors.validation("errors.transferEmpty");
  for (const l of input.lines) {
    if (dec(l.qty).lte(0)) throw errors.validation("errors.qtyMustBePositive");
  }
  const id = newId();
  await trx.insert(transfers).values({
    id,
    tenantId: ctx.tenantId,
    fromWarehouseId: input.fromWarehouseId,
    toWarehouseId: input.toWarehouseId,
    status: "draft",
    businessDate: input.businessDate,
    createdBy: ctx.actorId ?? "00000000-0000-0000-0000-000000000000",
  });
  await trx.insert(transferLines).values(
    input.lines.map((l) => ({
      id: newId(),
      tenantId: ctx.tenantId,
      transferId: id,
      productId: l.productId,
      lotId: l.lotId ?? null,
      qtyDispatched: toDb(dec(l.qty)),
    })),
  );
  await writeAudit(trx, {
    tenantId: ctx.tenantId,
    actorUserId: ctx.actorId,
    actorLabel: ctx.actorId ?? "system",
    action: "inventory.transfer.draft_created",
    entity: "transfer",
    entityId: id,
  });
  return id;
}

/**
 * Dispatch: source → in-transit carrying cost (P-12). Idempotent by status
 * guard + ledger source uniqueness (INV-05). Notifies destination rep if any.
 */
export async function dispatchTransfer(
  trx: Trx,
  ctx: ServiceCtx,
  transferId: string,
): Promise<void> {
  const t = await lockTransfer(trx, ctx.tenantId, transferId);
  if (t.status === "cancelled") throw errors.validation("errors.transferCancelled");
  if (t.status !== "draft") return; // already dispatched — idempotent

  const inTransit = await inTransitWarehouseId(trx, ctx.tenantId);
  const lines = await trx.select().from(transferLines).where(eq(transferLines.transferId, transferId));

  for (const l of lines) {
    const out = await recordMovement(trx, ctx, {
      warehouseId: t.fromWarehouseId,
      productId: l.productId,
      qty: l.qtyDispatched,
      movementType: "transfer_out",
      businessDate: t.businessDate,
      sourceType: "transfer",
      sourceId: transferId,
      effectKind: "dispatch_out",
      lineRef: l.id,
      bypassLots: true,
    });
    await recordMovement(trx, ctx, {
      warehouseId: inTransit,
      productId: l.productId,
      qty: l.qtyDispatched,
      movementType: "transfer_in",
      unitCost: out.unitCost, // cost travels with the goods
      businessDate: t.businessDate,
      sourceType: "transfer",
      sourceId: transferId,
      effectKind: "dispatch_in",
      lineRef: l.id,
      bypassLots: true,
    });
  }

  const transferNo = await nextDocNumber(trx, ctx.tenantId, "TR");
  await trx
    .update(transfers)
    .set({ status: "dispatched", transferNo, dispatchedAt: new Date(), dispatchedBy: ctx.actorId })
    .where(eq(transfers.id, transferId));

  const [dest] = await trx
    .select({ representativeUserId: warehouses.representativeUserId, name: warehouses.name })
    .from(warehouses)
    .where(eq(warehouses.id, t.toWarehouseId))
    .limit(1);
  if (dest?.representativeUserId) {
    await trx.insert(notifications).values({
      tenantId: ctx.tenantId,
      userId: dest.representativeUserId,
      kind: "transfer.dispatched",
      title: "تحويل مخزني بالطريق",
      body: `تم صرف تحويل رقم ${transferNo} إلى «${dest.name}». راجع الكميات واستلمها.`,
      payload: { transferId, transferNo },
    });
  }

  await writeAudit(trx, {
    tenantId: ctx.tenantId,
    actorUserId: ctx.actorId,
    actorLabel: ctx.actorId ?? "system",
    action: "inventory.transfer.dispatched",
    entity: "transfer",
    entityId: transferId,
    after: { transferNo, lines: lines.length },
  });
}

/**
 * Accept (full/partial) or dispute line quantities. Atomic `received ≤
 * dispatched` guard (INV-07); conflicts raise DomainErrors for the caller.
 */
export async function acceptTransfer(
  trx: Trx,
  ctx: ServiceCtx,
  transferId: string,
  accepts: AcceptInput[],
  opts: AcceptOptions,
): Promise<{ status: TransferRow["status"] }> {
  const t = await lockTransfer(trx, ctx.tenantId, transferId);
  if (t.status === "closed") throw errors.conflict("errors.transferAlreadyClosed", transferId);
  if (t.status === "received") throw errors.conflict("errors.transferAlreadyReceived", transferId);
  if (t.status !== "dispatched" && t.status !== "partially_received" && t.status !== "disputed") {
    throw errors.validation("errors.transferNotReceivable", transferId, { status: t.status });
  }
  const inTransit = await inTransitWarehouseId(trx, ctx.tenantId);

  const lines = await trx.select().from(transferLines).where(eq(transferLines.transferId, transferId));
  const byId = new Map(lines.map((l) => [l.id, l]));

  for (const a of accepts) {
    const line = byId.get(a.lineId);
    if (!line) throw errors.validation("errors.transferLineInvalid", a.lineId);
    const qty = dec(a.qty);
    if (qty.lte(0) && !a.discrepancyReason) continue;
    if (qty.lt(0)) throw errors.validation("errors.qtyMustBePositive");

    if (a.discrepancyReason) {
      await trx
        .update(transferLines)
        .set({ discrepancyReason: a.discrepancyReason })
        .where(eq(transferLines.id, a.lineId));
    }
    if (qty.gt(0)) {
      // movement first (savepoint-protected): a replayed movement means this
      // exact accept already happened — skip the line update entirely.
      const out = await recordMovement(trx, ctx, {
        warehouseId: inTransit,
        productId: line.productId,
        qty: toDb(qty),
        movementType: "transfer_out",
        businessDate: opts.businessDate,
        sourceType: "transfer",
        sourceId: transferId,
        effectKind: "accept_out",
        lineRef: `${a.lineId}:${opts.acceptRef}`,
        bypassLots: true,
      });
      if (out.replayed) continue;
      await recordMovement(trx, ctx, {
        warehouseId: t.toWarehouseId,
        productId: line.productId,
        qty: toDb(qty),
        movementType: "transfer_in",
        unitCost: out.unitCost,
        businessDate: opts.businessDate,
        sourceType: "transfer",
        sourceId: transferId,
        effectKind: "accept_in",
        lineRef: `${a.lineId}:${opts.acceptRef}`,
        bypassLots: true,
      });
      // atomic received <= dispatched guard (INV-07 concurrency backstop)
      const res = await trx.execute(sql`
        update transfer_lines
        set qty_received = qty_received + ${toDb(qty)}::numeric
        where id = ${a.lineId} and qty_received + ${toDb(qty)}::numeric <= qty_dispatched
        returning id
      `);
      if ((res as unknown as { rows: unknown[] }).rows.length === 0) {
        throw errors.conflict("errors.transferReceiveExceeds", a.lineId, {
          remaining: toDb(dec(line.qtyDispatched).minus(line.qtyReceived)),
        });
      }
    }
  }

  // recompute status
  const refreshed = await trx.select().from(transferLines).where(eq(transferLines.transferId, transferId));
  const allReceived = refreshed.every((l) => dec(l.qtyReceived).gte(dec(l.qtyDispatched)));
  const anyReceived = refreshed.some((l) => dec(l.qtyReceived).gt(0));
  const anyReason = refreshed.some((l) => l.discrepancyReason);
  let status: TransferRow["status"];
  if (allReceived) status = "received";
  else if (anyReason) status = "disputed";
  else if (anyReceived) status = "partially_received";
  else status = t.status;
  await trx.update(transfers).set({ status }).where(eq(transfers.id, transferId));

  await writeAudit(trx, {
    tenantId: ctx.tenantId,
    actorUserId: ctx.actorId,
    actorLabel: ctx.actorId ?? "system",
    action: "inventory.transfer.accepted",
    entity: "transfer",
    entityId: transferId,
    after: { status, accepts },
  });
  return { status };
}

/** Close a fully-received transfer (immutable afterwards). */
export async function closeTransfer(trx: Trx, ctx: ServiceCtx, transferId: string): Promise<void> {
  const t = await lockTransfer(trx, ctx.tenantId, transferId);
  if (t.status === "closed") return;
  if (t.status !== "received") {
    throw errors.validation("errors.transferNotClosable", transferId, { status: t.status });
  }
  await trx.update(transfers).set({ status: "closed" }).where(eq(transfers.id, transferId));
  await writeAudit(trx, {
    tenantId: ctx.tenantId,
    actorUserId: ctx.actorId,
    actorLabel: ctx.actorId ?? "system",
    action: "inventory.transfer.closed",
    entity: "transfer",
    entityId: transferId,
  });
}

/** Cancel an untouched draft. */
export async function cancelTransferDraft(trx: Trx, ctx: ServiceCtx, transferId: string): Promise<void> {
  const t = await lockTransfer(trx, ctx.tenantId, transferId);
  if (t.status !== "draft") throw errors.validation("errors.transferNotCancellable", transferId);
  await trx.update(transfers).set({ status: "cancelled" }).where(eq(transfers.id, transferId));
  await writeAudit(trx, {
    tenantId: ctx.tenantId,
    actorUserId: ctx.actorId,
    actorLabel: ctx.actorId ?? "system",
    action: "inventory.transfer.cancelled",
    entity: "transfer",
    entityId: transferId,
  });
}

export { Decimal };
