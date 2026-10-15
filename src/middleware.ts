/**
 * Edge gate — cookie *presence* only. Real authorization happens server-side
 * in services/pages (SECURITY_AND_TENANCY §4); this just short-circuits the
 * obvious anonymous case before rendering.
 */

import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/modules/identity/constants";

const PUBLIC_PREFIXES = ["/login", "/api", "/_next", "/favicon"];
/** Platform console cookie (PLATFORM_ADMIN §6.5) — its own namespace. */
const PLATFORM_COOKIE = "hisab_platform_session";

export function middleware(req: NextRequest) {
  const path = req.nextUrl.pathname;
  if (
    PUBLIC_PREFIXES.some((p) => path.startsWith(p)) ||
    path.includes(".") // static assets, manifest, icons
  ) {
    return NextResponse.next();
  }

  // The console is gated by its OWN cookie: a tenant session can never satisfy
  // a platform request, and a platform session can never satisfy the ERP (which
  // requires a tenant binding server-side).
  if (path.startsWith("/platform")) {
    const isLogin = path === "/platform/login" || path.startsWith("/platform/login/");
    const hasPlatformSession = Boolean(req.cookies.get(PLATFORM_COOKIE)?.value);
    if (!hasPlatformSession && !isLogin) {
      const url = req.nextUrl.clone();
      url.pathname = "/platform/login";
      url.search = "";
      return NextResponse.redirect(url);
    }
    if (hasPlatformSession && isLogin) {
      const url = req.nextUrl.clone();
      url.pathname = "/platform";
      url.search = "";
      return NextResponse.redirect(url);
    }
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
