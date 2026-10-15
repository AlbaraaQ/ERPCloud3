"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTheme } from "next-themes";
import clsx from "clsx";
import { logoutAction } from "@/modules/identity/actions";
import type { Dict } from "@/i18n";
import {
  LayoutDashboard,
  ShoppingCart,
  FileText,
  Boxes,
  Factory,
  Landmark,
  ShoppingBag,
  Wallet,
  BarChart3,
  Receipt,
  Users,
  Settings,
  Scale,
  Bell,
  Sun,
  Moon,
  MonitorSmartphone,
  LogOut,
  ChevronDown,
  type LucideIcon,
} from "lucide-react";

export interface ShellProps {
  children: ReactNode;
  t: Dict;
  userName: string;
  userEmail: string;
  tenantName: string;
  tenantStatus: string;
  permissions: string[];
  unreadNotifications: number;
  locale: string;
}

interface NavItem {
  href: string;
  icon: LucideIcon;
  label: (t: Dict) => string;
  perm?: string;
  enabled: boolean;
}

const NAV_SECTIONS: { label: (t: Dict) => string; items: NavItem[] }[] = [
  {
    label: (t) => t.nav.sectionMain,
    items: [
      { href: "/dashboard", icon: LayoutDashboard, label: (t) => t.nav.dashboard, perm: "dashboard.view", enabled: true },
      { href: "/accounting", icon: Landmark, label: (t) => t.accounting.title, perm: "accounting.journal.view", enabled: true },
      { href: "/pos", icon: ShoppingCart, label: (t) => t.nav.pos, perm: "sales.pos.use", enabled: true },
      { href: "/sales", icon: FileText, label: (t) => t.nav.sales, perm: "sales.invoice.view", enabled: true },
    ],
  },
  {
    label: (t) => t.nav.sectionOps,
    items: [
      { href: "/inventory", icon: Boxes, label: (t) => t.nav.inventory, perm: "inventory.view", enabled: true },
      { href: "/manufacturing", icon: Factory, label: (t) => t.nav.manufacturing, perm: "production.manage", enabled: true },
      { href: "/purchasing", icon: ShoppingBag, label: (t) => t.nav.purchasing, perm: "purchasing.manage", enabled: true },
      { href: "/cash", icon: Wallet, label: (t) => t.nav.cash, perm: "cash.manage", enabled: true },
    ],
  },
  {
    label: (t) => t.nav.sectionAdmin,
    items: [
      { href: "/reports", icon: BarChart3, label: (t) => t.nav.reports, perm: "reports.view", enabled: false },
      { href: "/settlement", icon: Scale, label: (t) => t.rep.rqTitle, perm: "settlement.review", enabled: true },
      { href: "/tax", icon: Receipt, label: (t) => t.nav.tax, perm: "tax.view", enabled: false },
      { href: "/hr", icon: Users, label: (t) => t.nav.hr, perm: "hr.employees.manage", enabled: false },
      { href: "/settings", icon: Settings, label: (t) => t.nav.settings, perm: "settings.company.manage", enabled: false },
    ],
  },
];

function ThemeToggle({ t }: { t: Dict }) {
  const { theme, setTheme } = useTheme();
  const cycle = () => setTheme(theme === "light" ? "dark" : theme === "dark" ? "system" : "light");
  const Icon = theme === "light" ? Sun : theme === "dark" ? Moon : MonitorSmartphone;
  return (
    <button
      type="button"
      onClick={cycle}
      className="btn-ghost btn !px-2.5"
      title={`${t.shell.theme}: ${theme === "light" ? t.shell.themeLight : theme === "dark" ? t.shell.themeDark : t.shell.themeSystem}`}
      aria-label={t.shell.theme}
    >
      <Icon className="h-5 w-5" aria-hidden />
    </button>
  );
}

export function AppShell({
  children,
  t,
  userName,
  userEmail,
  tenantName,
  tenantStatus,
  permissions,
  unreadNotifications,
}: ShellProps) {
  const pathname = usePathname();
  const has = (perm?: string) => !perm || permissions.includes(perm);

  return (
    <div className="flex min-h-screen">
      {/* Sidebar */}
      <aside className="fixed inset-y-0 start-0 z-30 flex w-64 flex-col border-e border-border bg-surface">
        <div className="flex h-16 items-center gap-3 border-b border-border px-5">
          <div className="grid h-9 w-9 place-items-center rounded-xl bg-primary text-primary-foreground">
            <Landmark className="h-5 w-5" aria-hidden />
          </div>
          <div className="min-w-0">
            <p className="truncate text-sm font-bold leading-tight">{tenantName}</p>
            <p className="text-[11px] text-muted">
              {t.app.name}
              {tenantStatus === "trial" && (
                <span className="ms-1.5 rounded-md bg-warning-soft px-1.5 py-0.5 text-[10px] font-semibold text-warning">
                  {t.shell.trialBadge}
                </span>
              )}
            </p>
          </div>
        </div>

        <nav className="flex-1 space-y-6 overflow-y-auto px-3 py-5">
          {NAV_SECTIONS.map((section, si) => {
            const visible = section.items.filter((i) => has(i.perm));
            if (visible.length === 0) return null;
            return (
              <div key={si}>
                <p className="mb-2 px-3 text-[11px] font-semibold uppercase tracking-wider text-muted">
                  {section.label(t)}
                </p>
                <ul className="space-y-1">
                  {visible.map((item) => {
                    const active = item.enabled && pathname.startsWith(item.href);
                    const Icon = item.icon;
                    return (
                      <li key={item.href}>
                        {item.enabled ? (
                          <Link
                            href={item.href}
                            aria-current={active ? "page" : undefined}
                            className={clsx(
                              "flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors",
                              active
                                ? "bg-primary-soft text-primary"
                                : "text-foreground/80 hover:bg-surface-2 hover:text-foreground",
                            )}
                          >
                            <Icon className="h-[18px] w-[18px] shrink-0" aria-hidden />
                            <span className="flex-1">{item.label(t)}</span>
                          </Link>
                        ) : (
                          <span
                            className="flex cursor-not-allowed items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium text-muted/70"
                            title={t.common.soon}
                          >
                            <Icon className="h-[18px] w-[18px] shrink-0" aria-hidden />
                            <span className="flex-1">{item.label(t)}</span>
                            <span className="rounded-md bg-surface-3 px-1.5 py-0.5 text-[10px] font-semibold text-muted">
                              {t.common.soon.split("—")[0].trim()}
                            </span>
                          </span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}
        </nav>

        {/* User + logout */}
        <div className="border-t border-border p-3">
          <details className="group">
            <summary className="flex cursor-pointer list-none items-center gap-3 rounded-xl px-3 py-2.5 hover:bg-surface-2 [&::-webkit-details-marker]:hidden">
              <span className="grid h-9 w-9 shrink-0 place-items-center overflow-hidden rounded-full bg-primary-soft text-sm font-bold text-primary">
                {userName.slice(0, 1)}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold">{userName}</span>
                <span className="block truncate text-[11px] text-muted" dir="ltr">
                  {userEmail}
                </span>
              </span>
              <ChevronDown className="h-4 w-4 text-muted transition-transform group-open:rotate-180" aria-hidden />
            </summary>
            <div className="mt-1 px-1 pb-1">
              <form action={logoutAction}>
                <button type="submit" className="btn btn-ghost w-full justify-start text-danger">
                  <LogOut className="h-4 w-4 rtl:-scale-x-100" aria-hidden />
                  {t.shell.logout}
                </button>
              </form>
            </div>
          </details>
        </div>
      </aside>

      {/* Content */}
      <div className="flex min-w-0 flex-1 flex-col ps-64">
        <header className="sticky top-0 z-20 flex h-16 items-center justify-end gap-2 border-b border-border bg-background/80 px-6 backdrop-blur">
          <button type="button" className="btn btn-ghost relative !px-2.5" title={t.shell.notifications} aria-label={t.shell.notifications}>
            <Bell className="h-5 w-5" aria-hidden />
            {unreadNotifications > 0 && (
              <span className="absolute -top-0.5 -end-0.5 grid h-5 min-w-5 place-items-center rounded-full bg-danger px-1 text-[10px] font-bold text-white">
                {unreadNotifications}
              </span>
            )}
          </button>
          <ThemeToggle t={t} />
        </header>

        <main className="flex-1 px-8 py-8">{children}</main>
      </div>
    </div>
  );
}
