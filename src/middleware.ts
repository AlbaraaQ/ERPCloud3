/**
 * Edge gate — cookie *presence* only. Real authorization happens server-side
 * in services/pages (SECURITY_AND_TENANCY §4); this just short-circuits the
 * obvious anonymous case before rendering.
 */

import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/modules/identity/constants";

const PUBLIC_PREFIXES = ["/login", "/api", "/_next", "/favicon"];

export function middleware(req: NextRequest) {
  const path = req.nextUrl.pathname;
  if (
    PUBLIC_PREFIXES.some((p) => path.startsWith(p)) ||
    path.includes(".") // static assets, manifest, icons
  ) {
    return NextResponse.next();
  }

  const hasSession = Boolean(req.cookies.get(SESSION_COOKIE)?.value);
  if (!hasSession) {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.search = path !== "/" ? `?next=${encodeURIComponent(path)}` : "";
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image).*)"],
};
