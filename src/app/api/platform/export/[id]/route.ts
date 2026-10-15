/**
 * Platform export download (PLATFORM_ADMIN §5).
 *
 * Route handler (a page may not return a Response). Guarded by the platform
 * session + permission, re-verifies the artifact checksum before serving it, and
 * writes both the platform chain and the tenant-visible chain on every download.
 */

import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { PLATFORM_SESSION_COOKIE } from "@/modules/platform/session";
import { buildPlatformContext, platformActorLabel, hasPlatformPermission } from "@/modules/platform/context";
import { downloadTenantExport } from "@/modules/platform/exports";
import { toDomainError } from "@/modules/shared/result";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const store = await cookies();
  const token = store.get(PLATFORM_SESSION_COOKIE)?.value;
  const platform = token ? await buildPlatformContext(token) : null;
  if (!platform) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (!hasPlatformPermission(platform, "platform.exports.manage")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  try {
    const file = await downloadTenantExport({
      exportId: id,
      actorLabel: platformActorLabel(platform),
      actorPlatformUserId: platform.platformUserId,
    });
    return new NextResponse(new Uint8Array(file.buffer), {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": `attachment; filename="${file.filename}"`,
        "cache-control": "no-store",
      },
    });
  } catch (e) {
    const err = toDomainError(e, "errors.unexpected");
    const status = err.messageKey === "errors.exportExpired" || err.messageKey === "errors.exportNotReady" ? 410 : 400;
    return NextResponse.json({ error: err.messageKey, detail: err.detail }, { status });
  }
}
