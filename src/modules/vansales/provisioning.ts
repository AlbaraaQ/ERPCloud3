/**
 * Representative provisioning (FR-050, VAN_SALES_WORKFLOW §1).
 * Assigning the rep role idempotently creates exactly one custody warehouse
 * (DB unique (tenant, representative_user_id) is the hard guarantee — AC-001/2).
 */

import { and, eq } from "drizzle-orm";
import {
  employees,
  representatives,
  roles,
  userRoles,
  users,
  warehouses,
  devices,
} from "@/db/schema";
import type { Trx } from "@/modules/shared/db-context";
import { errors } from "@/modules/shared/result";
import { newId } from "@/modules/shared/ids";
import { writeAudit } from "@/modules/shared/audit";
import type { ServiceCtx } from "@/modules/shared/context";

export interface ProvisionResult {
  representativeId: string;
  employeeId: string;
  custodyWarehouseId: string;
  createdWarehouse: boolean;
}

export async function provisionRepresentative(
  trx: Trx,
  ctx: ServiceCtx,
  userId: string,
): Promise<ProvisionResult> {
  const [user] = await trx
    .select()
    .from(users)
    .where(and(eq(users.tenantId, ctx.tenantId), eq(users.id, userId)))
    .limit(1);
  if (!user) throw errors.notFound("user", userId);

  // 1. employee record
  let [emp] = await trx
    .select()
    .from(employees)
    .where(and(eq(employees.tenantId, ctx.tenantId), eq(employees.userId, userId)))
    .limit(1);
  if (!emp) {
    [emp] = await trx
      .insert(employees)
      .values({ tenantId: ctx.tenantId, userId, fullName: user.name, phone: user.phone })
      .returning();
  }

  // 2. role assignment (field_rep), idempotent
  const [repRole] = await trx
    .select()
    .from(roles)
    .where(and(eq(roles.tenantId, ctx.tenantId), eq(roles.key, "field_rep")))
    .limit(1);
  if (!repRole) throw errors.configuration("errors.missingRepRole");
  await trx
    .insert(userRoles)
    .values({ tenantId: ctx.tenantId, userId, roleId: repRole.id })
    .onConflictDoNothing();

  // 3. representative row, idempotent (unique tenant+user)
  let [rep] = await trx
    .select()
    .from(representatives)
    .where(and(eq(representatives.tenantId, ctx.tenantId), eq(representatives.userId, userId)))
    .limit(1);
  if (!rep) {
    [rep] = await trx
      .insert(representatives)
      .values({ tenantId: ctx.tenantId, userId, employeeId: emp.id })
      .returning();
  }

  // 4. custody warehouse — the invariant: exactly one, race-safe (AC-001/002).
  //    Code uses the uuidv7 random TAIL (time-prefix would collide for reps
  //    provisioned in the same millisecond-high window → unique-code conflict
  //    combined with DO NOTHING → missing warehouse. Found via InvariantViolation).
  const whName = `مخزن عهدة — ${user.name}`;
  const whCode = `REP-${userId.replace(/-/g, "").slice(-12).toUpperCase()}`;
  await trx
    .insert(warehouses)
    .values({
      tenantId: ctx.tenantId,
      code: whCode,
      name: whName,
      type: "representative_custody",
      representativeUserId: userId,
    })
    .onConflictDoNothing(); // unique (tenant, representative_user_id) is the guard
  const [wh] = await trx
    .select()
    .from(warehouses)
    .where(and(eq(warehouses.tenantId, ctx.tenantId), eq(warehouses.representativeUserId, userId)))
    .limit(1);
  if (!wh) throw errors.invariant("custody warehouse missing after upsert");

  const createdWarehouse = !rep.custodyWarehouseId;
  if (createdWarehouse) {
    await trx
      .update(representatives)
      .set({ custodyWarehouseId: wh.id })
      .where(eq(representatives.id, rep.id));
  }

  await writeAudit(trx, {
    tenantId: ctx.tenantId,
    actorUserId: ctx.actorId,
    actorLabel: ctx.actorId ?? "system",
    action: createdWarehouse
      ? "vansales.rep.provisioned"
      : "vansales.rep.provision_replayed",
    entity: "representative",
    entityId: rep.id,
    after: { custodyWarehouseId: wh.id, employeeId: emp.id },
  });

  return { representativeId: rep.id, employeeId: emp.id, custodyWarehouseId: wh.id, createdWarehouse };
}

/**
 * Rep-role removal protects custody: never deletes history; blocks when the
 * custody warehouse holds stock (caller must settle/transfer first) unless
 * forced by a privileged action with a documented plan (audit).
 */
export async function deactivateRepresentative(
  trx: Trx,
  ctx: ServiceCtx,
  userId: string,
  opts: { force?: boolean } = {},
): Promise<void> {
  const [rep] = await trx
    .select()
    .from(representatives)
    .where(and(eq(representatives.tenantId, ctx.tenantId), eq(representatives.userId, userId)))
    .limit(1);
  if (!rep) return;
  if (!rep.active) return;

  if (rep.custodyWarehouseId) {
    const { sql } = await import("drizzle-orm");
    const bal = await trx.execute(sql`
      select coalesce(sum(abs(on_hand)), 0)::text as total
      from stock_balances where tenant_id = ${ctx.tenantId} and warehouse_id = ${rep.custodyWarehouseId}
    `);
    const total = Number((bal as unknown as { rows: { total: string }[] }).rows[0].total);
    if (total > 0.000001 && !opts.force) {
      throw errors.validation("errors.repCustodyNotEmpty", undefined, { custody: total });
    }
  }
  await trx.update(representatives).set({ active: false }).where(eq(representatives.id, rep.id));
  await writeAudit(trx, {
    tenantId: ctx.tenantId,
    actorUserId: ctx.actorId,
    actorLabel: ctx.actorId ?? "system",
    action: "vansales.rep.deactivated",
    entity: "representative",
    entityId: rep.id,
    after: { forced: opts.force ?? false },
  });
}

/** Register (or re-activate) a sync device for a user (SEC §7). */
export async function registerDevice(
  trx: Trx,
  ctx: ServiceCtx,
  input: { deviceId: string; userId: string; label: string; platform?: string },
): Promise<void> {
  const [existing] = await trx
    .select()
    .from(devices)
    .where(eq(devices.id, input.deviceId))
    .limit(1);
  if (existing) {
    if (existing.status === "revoked") {
      throw errors.validation("errors.deviceRevoked");
    }
    await trx
      .update(devices)
      .set({ lastSeenAt: new Date(), label: input.label })
      .where(eq(devices.id, input.deviceId));
    return;
  }
  await trx.insert(devices).values({
    id: input.deviceId,
    tenantId: ctx.tenantId,
    userId: input.userId,
    label: input.label,
    platform: input.platform ?? null,
    lastSeenAt: new Date(),
  });
  await writeAudit(trx, {
    tenantId: ctx.tenantId,
    actorUserId: ctx.actorId,
    actorLabel: ctx.actorId ?? "system",
    action: "vansales.device.registered",
    entity: "device",
    entityId: input.deviceId,
    after: { label: input.label },
  });
}

export async function revokeDevice(
  trx: Trx,
  ctx: ServiceCtx,
  deviceId: string,
): Promise<void> {
  await trx.update(devices).set({ status: "revoked" }).where(eq(devices.id, deviceId));
  await writeAudit(trx, {
    tenantId: ctx.tenantId,
    actorUserId: ctx.actorId,
    actorLabel: ctx.actorId ?? "system",
    action: "vansales.device.revoked",
    entity: "device",
    entityId: deviceId,
  });
}
