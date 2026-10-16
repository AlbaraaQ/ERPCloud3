"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { repDb, kvGet, kvSet } from "@/pwa/sync-db";
import { outboxCounts } from "@/pwa/sync-engine";
import { provisionSelfAction } from "@/modules/vansales/actions";
import { getDict } from "@/i18n/dicts";
import type { Dict } from "@/i18n/dicts";
import {
  ShoppingCart, Truck, Scale, CloudUpload, CloudOff, Warehouse, Zap, CheckCircle2,
} from "lucide-react";

const t = getDict("ar");

interface MeInfo {
  custodyWarehouseId: string | null;
  custodyWarehouseName: string | null;
  name: string;
}

export default function RepHome() {
  const [me, setMe] = useState<MeInfo | null>(null);
  const [counts, setCounts] = useState({ pending: 0, synced: 0 });
  const [online, setOnline] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [stockValue, setStockValue] = useState<number>(0);

  useEffect(() => {
    (async () => {
      const m = await kvGet<MeInfo>("me");
      setMe(m);
      const c = await outboxCounts();
      setCounts({ pending: c.pending + c.syncing, synced: c.synced });
      setOnline(navigator.onLine);
      const stocks = await repDb().stock.toArray();
      setStockValue(stocks.reduce((s, x) => s + Number(x.onHand) * Number(x.avgCost), 0));
      window.addEventListener("online", () => setOnline(true));
      window.addEventListener("offline", () => setOnline(false));
    })();
  }, []);

  async function provision() {
    setBusy(true);
    setMsg(null);
    try {
      const res = await provisionSelfAction();
      if (res.ok && res.custodyWarehouseId) {
        setMe((m) => ({ custodyWarehouseId: res.custodyWarehouseId!, custodyWarehouseName: null, name: m?.name ?? "" }));
        setMsg(t.rep.provisioned);
        await kvSet("me", { custodyWarehouseId: res.custodyWarehouseId, custodyWarehouseName: null, name: me?.name ?? "" });
      } else {
        setMsg(t.rep.provisionFail);
      }
    } finally {
      setBusy(false);
    }
  }

  const cards = [
    { href: "/rep/pos", icon: ShoppingCart, label: t.rep.quickSell, tone: "bg-primary text-primary-foreground" },
    { href: "/rep/transfers", icon: Truck, label: t.rep.transfersTitle, tone: "bg-info-soft text-info" },
    { href: "/rep/settle", icon: Scale, label: t.rep.settleTitle, tone: "bg-warning-soft text-warning" },
    { href: "/rep/sync", icon: CloudUpload, label: t.rep.syncTitle, tone: "bg-surface-2 text-foreground" },
  ];

  return (
    <div className="space-y-5">
      <h1 className="text-xl font-bold">{t.rep.homeTitle}</h1>

      {msg && (
        <div className="flex items-center gap-2 rounded-xl bg-success-soft px-4 py-2.5 text-sm">
          <CheckCircle2 className="h-4 w-4 text-success" /> {msg}
        </div>
      )}

      <section className="card flex items-center justify-between p-4">
        <div className="flex items-center gap-3">
          <span className="grid h-11 w-11 place-items-center rounded-xl bg-primary-soft text-primary">
            <Warehouse className="h-5 w-5" />
          </span>
          <div>
            <p className="text-sm font-semibold">{t.rep.custody}</p>
            <p className="text-xs text-muted">
              {me?.custodyWarehouseId
                ? (me.custodyWarehouseName ?? t.rep.roughStockWarn)
                : t.rep.custodyNone}
            </p>
          </div>
        </div>
        {me?.custodyWarehouseId ? (
          <div className="text-end">
            <p className="tnum text-lg font-bold text-primary" dir="ltr">{stockValue.toFixed(2)}</p>
            <p className="text-[10px] text-muted">{t.common.sar}</p>
          </div>
        ) : (
          <button type="button" onClick={provision} disabled={busy} className="btn btn-primary !py-2 text-xs disabled:opacity-50">
            <Zap className="h-4 w-4" /> {t.rep.provision}
          </button>
        )}
      </section>

      <section className="grid grid-cols-2 gap-3">
        {cards.map(({ href, icon: Icon, label, tone }) => (
          <Link key={href} href={href} className={`card flex items-center gap-3 p-4 transition-transform active:scale-[0.98] ${tone.includes("bg-primary text-primary") ? "bg-primary text-primary-foreground" : ""}`}>
            <span className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl ${tone}`}>
              <Icon className="h-5 w-5" />
            </span>
            <span className="text-sm font-semibold leading-tight">{label}</span>
          </Link>
        ))}
      </section>

      <section className="card space-y-2 p-4">
        <h2 className="text-sm font-semibold">{t.rep.todayOps}</h2>
        <div className="grid grid-cols-2 gap-3">
          <div className="rounded-xl bg-surface-2 p-3 text-center">
            <p className="tnum text-2xl font-bold">{counts.synced}</p>
            <p className="text-[11px] text-muted">{t.rep.syncedCount}</p>
          </div>
          <div className="rounded-xl bg-surface-2 p-3 text-center">
            <p className={`tnum text-2xl font-bold ${counts.pending > 0 ? "text-warning" : ""}`}>{counts.pending}</p>
            <p className="text-[11px] text-muted">{t.rep.pendingCount}</p>
          </div>
        </div>
        {!online && (
          <p className="flex items-center gap-1.5 rounded-lg bg-danger-soft px-3 py-2 text-xs text-danger">
            <CloudOff className="h-3.5 w-3.5" /> {t.rep.offline} — {t.rep.queued}
          </p>
        )}
      </section>
    </div>
  );
}
