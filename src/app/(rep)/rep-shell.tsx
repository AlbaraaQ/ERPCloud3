"use client";

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import clsx from "clsx";
import type { Dict } from "@/i18n/dicts";
import { startSyncEngine, outboxCounts } from "@/pwa/sync-engine";
import {
  LayoutGrid, ShoppingCart, Truck, CloudUpload, Scale, Landmark,
} from "lucide-react";

interface Props {
  children: ReactNode;
  t: Dict;
  userName: string;
  tenantName: string;
  errors: Record<string, string>;
}

const TABS = [
  { href: "/rep", icon: LayoutGrid, key: "home" },
  { href: "/rep/pos", icon: ShoppingCart, key: "pos" },
  { href: "/rep/transfers", icon: Truck, key: "transfers" },
  { href: "/rep/sync", icon: CloudUpload, key: "sync" },
  { href: "/rep/settle", icon: Scale, key: "settle" },
] as const;

export function RepShell({ children, t, userName, tenantName }: Props) {
  const pathname = usePathname();
  const [online, setOnline] = useState(true);
  const [pending, setPending] = useState(0);

  useEffect(() => {
    void startSyncEngine();
    if ("serviceWorker" in navigator) {
      void navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {});
    }
    const upd = async () => {
      setOnline(navigator.onLine);
      const counts = await outboxCounts();
      setPending((counts.pending ?? 0) + (counts.rejected ?? 0) + (counts.conflict ?? 0));
    };
    void upd();
    window.addEventListener("online", upd);
    window.addEventListener("offline", upd);
    const i = setInterval(upd, 4000);
    return () => {
      window.removeEventListener("online", upd);
      window.removeEventListener("offline", upd);
      clearInterval(i);
    };
  }, []);

  const tabLabel = (key: string) =>
    ({ home: t.rep.tabHome, pos: t.rep.tabPos, transfers: t.rep.tabTransfers, sync: t.rep.tabSync, settle: t.rep.tabSettle })[key];

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <header className="sticky top-0 z-30 flex h-14 items-center justify-between border-b border-border bg-surface px-4">
        <div className="flex items-center gap-2.5">
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-primary text-primary-foreground">
            <Landmark className="h-4 w-4" aria-hidden />
          </span>
          <div className="leading-tight">
            <p className="text-sm font-bold">{userName}</p>
            <p className="text-[10px] text-muted">{tenantName}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {pending > 0 && (
            <Link href="/rep/sync" className="rounded-lg bg-warning-soft px-2 py-1 text-[11px] font-bold text-warning">
              {pending} ⌛
            </Link>
          )}
          <span
            className={clsx(
              "flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-[11px] font-semibold",
              online ? "bg-success-soft text-success" : "bg-danger-soft text-danger",
            )}
            role="status"
          >
            <span className={clsx("h-2 w-2 rounded-full", online ? "bg-success" : "bg-danger")} />
            {online ? t.rep.online : t.rep.offline}
          </span>
        </div>
      </header>

      <main className="flex-1 overflow-y-auto px-4 pb-24 pt-4">{children}</main>

      <nav className="fixed inset-x-0 bottom-0 z-30 border-t border-border bg-surface/95 pb-[env(safe-area-inset-bottom)] backdrop-blur">
        <div className="mx-auto grid max-w-lg grid-cols-5">
          {TABS.map(({ href, icon: Icon, key }) => {
            const active = pathname === href;
            return (
              <Link
                key={href}
                href={href}
                aria-current={active ? "page" : undefined}
                className={clsx(
                  "flex flex-col items-center gap-0.5 py-2.5 text-[10px] font-semibold",
                  active ? "text-primary" : "text-muted",
                )}
              >
                <Icon className="h-5 w-5" aria-hidden />
                {tabLabel(key)}
              </Link>
            );
          })}
        </div>
      </nav>
    </div>
  );
}
