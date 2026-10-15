import { z } from "zod";
import { getSessionContext } from "@/modules/identity/auth";
import { serviceCtxOf } from "@/modules/shared/context";
import { isDomainError } from "@/modules/shared/result";
import { logger } from "@/modules/shared/logger";
import { applyOpBatch, hashPayload, type SyncOp } from "@/modules/vansales/sync";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const opSchema = z.object({
  opId: z.string().uuid(),
  opType: z.string().min(3).max(60),
  payload: z.record(z.string(), z.unknown()),
  payloadHash: z.string().regex(/^[0-9a-f]{64}$/),
});

const pushSchema = z.object({
  deviceId: z.string().uuid(),
  ops: z.array(opSchema).min(1).max(200),
});

export async function POST(req: Request) {
  const ctx = await getSessionContext();
  if (!ctx?.tenant || !ctx.userId) {
    return Response.json({ error: "unauthenticated" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }
  const parsed = pushSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: "invalid_request", issues: parsed.error.issues.slice(0, 3) }, { status: 400 });
  }

  const { deviceId, ops } = parsed.data as { deviceId: string; ops: SyncOp[] };
  // structural hash sanity: client-declared hash must match computed payload hash
  for (const op of ops) {
    if (op.payloadHash !== hashPayload(op.payload)) {
      return Response.json({ error: "hash_mismatch", opId: op.opId }, { status: 400 });
    }
  }

  try {
    const results = await applyOpBatch(serviceCtxOf(ctx), deviceId, ops);
    return Response.json({ results, serverTime: new Date().toISOString() });
  } catch (e) {
    if (isDomainError(e)) {
      const status = e.messageKey === "errors.deviceNotRegistered" ? 409 : 403;
      return Response.json({ error: e.messageKey }, { status });
    }
    logger.error({ err: e }, "sync push failed");
    return Response.json({ error: "internal" }, { status: 500 });
  }
}
