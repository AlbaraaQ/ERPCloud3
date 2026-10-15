import { z } from "zod";
import { getSessionContext } from "@/modules/identity/auth";
import { withTenant } from "@/modules/shared/db-context";
import { serviceCtxOf } from "@/modules/shared/context";
import { registerDevice } from "@/modules/vansales/provisioning";
import { isDomainError } from "@/modules/shared/result";
import { logger } from "@/modules/shared/logger";

export const dynamic = "force-dynamic";

const schema = z.object({
  deviceId: z.string().uuid(),
  label: z.string().min(1).max(120),
  platform: z.string().max(60).optional(),
});

/** First-run device registration for the signed-in user (SEC §7). */
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
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }
  try {
    await withTenant(ctx.tenant.id, (trx) =>
      registerDevice(trx, serviceCtxOf(ctx), {
        deviceId: parsed.data.deviceId,
        userId: ctx.userId!,
        label: parsed.data.label,
        platform: parsed.data.platform ?? req.headers.get("user-agent")?.slice(0, 60),
      }),
    );
    return Response.json({ ok: true });
  } catch (e) {
    if (isDomainError(e)) return Response.json({ error: e.messageKey }, { status: 409 });
    logger.error({ err: e }, "device register failed");
    return Response.json({ error: "internal" }, { status: 500 });
  }
}
