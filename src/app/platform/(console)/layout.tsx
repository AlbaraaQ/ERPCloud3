/**
 * Platform console shell (PLATFORM_ADMIN §7: Arabic-first, same design system).
 *
 * The guard is server-side: without a platform session the layout 404s — the
 * middleware already redirected anonymous visitors, and this is the belt to that
 * suspenders. Nothing in this tree can reach tenant services, because a platform
 * session has no tenant binding.
 */

import type { ReactNode } from "react";
import Link from "next/link";
import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import {
  Activity,
  Building2,
  CreditCard,
  Flag,
  HardDriveDownload,
  LayoutDashboard,
  LogOut,
  ScrollText,
  ShieldAlert,
  UserCog,
} from "lucide-react";
import { getPlatformContext } from "@/modules/platform/context";
import { PLATFORM_SESSION_COOKIE } from "@/modules/platform/session";
import { platformLogoutAction } from "@/modules/platform/actions";
import { countOpenAlerts } from "@/modules/platform/alerts";
import { getLocale, getDict } from "@/i18n";

export const dynamic = "force-dynamic";
export const metadata = { title: "Hisab Platform" };

export default async function PlatformLayout({ children }: { children: ReactNode }) {
  const ctx = await getPlatformContext();
  if (!ctx) {
    // No cookie at all: the middleware already sends visitors to the login page,
    // so reaching here means someone deep-linked — 404 (the console is not
    // advertised). A cookie that no longer works (revoked, expired, or an account
    // that was disabled) is a different case: it must not dead-end the operator.
    const stale = (await cookies()).get(PLATFORM_SESSION_COOKIE)?.value;
    if (stale) redirect("/platform/login?expired=1");
    notFound();
  }

  const locale = await getLocale();
  const t = getDict(locale);
  const alerts = await countOpenAlerts().catch(() => ({ info: 0, warning: 0, critical: 0 }));
  const openAlerts = alerts.critical + alerts.warning + alerts.info;

  const nav = [
    { href: "/platform", label: t.platform.navDashboard, icon: LayoutDashboard },
    { href: "/platform/tenants", label: t.platform.navTenants, icon: Building2 },
    { href: "/platform/plans", label: t.platform.navPlans, icon: CreditCard },
    { href: "/platform/flags", label: t.platform.navFlags, icon: Flag },
    { href: "/platform/backups", label: t.platform.navBackups, icon: HardDriveDownload },
    { href: "/platform/alerts", label: t.platform.navAlerts, icon: ShieldAlert, badge: openAlerts },
    { href: "/platform/exports", label: t.platform.navExports, icon: Activity },
    { href: "/platform/audit", label: t.platform.navAudit, icon: ScrollText },
  ];

  return (
    <div className="min-h-screen bg-surface-2/40 lg:grid lg:grid-cols-[16rem_1fr]">
      <aside className="border-e border-border bg-surface lg:sticky lg:top-0 lg:h-screen">
        <div className="flex items-center gap-3 border-b border-border px-4 py-4">
          <div className="grid h-10 w-10 place-items-center rounded-xl bg-foreground text-background">
            <UserCog className="h-5 w-5" aria-hidden />
          </div>
          <div className="min-w-0">
            <p className="truncate text-sm font-bold leading-tight">{t.platform.title}</p>
            <p className="truncate text-[11px] text-muted">
              {ctx.name} · <span className="font-mono">{ctx.role}</span>
            </p>
          </div>
        </div>
        <nav className="space-y-1 px-3 py-4">
          {nav.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="flex items-center justify-between gap-2 rounded-xl px-3 py-2 text-sm font-medium hover:bg-surface-2"
            >
              <span className="flex items-center gap-2">
                <item.icon className="h-4 w-4 text-muted" aria-hidden />
                {item.label}
              </span>
              {item.badge ? (
                <span className="rounded-md bg-danger-soft px-1.5 py-0.5 text-[10px] font-bold text-danger tnum">
                  {item.badge}
                </span>
              ) : null}
            </Link>
          ))}
        </nav>
        <div className="border-t border-border px-3 py-3">
          <form action={platformLogoutAction}>
            <button type="submit" className="btn btn-ghost w-full justify-start text-sm">
              <LogOut className="h-4 w-4" aria-hidden />
              {t.platform.logout}
            </button>
          </form>
        </div>
      </aside>
      <main className="min-w-0 px-4 py-6 lg:px-8">{children}</main>
    </div>
  );
}
