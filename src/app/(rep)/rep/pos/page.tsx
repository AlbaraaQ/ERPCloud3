"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { repDb, kvGet } from "@/pwa/sync-db";
import { enqueueOp } from "@/pwa/sync-engine";
import { getDict, type Dict } from "@/i18n/dicts";
import {
  Search, Trash2, Plus, Minus, Gift, ShoppingCart, CheckCircle2, CloudOff,
} from "lucide-react";
import { todayBusinessDate } from "@/modules/shared/dates";

const t: Dict = getDict("ar");

interface CartLine {
  productId: string;
  name: string;
  qty: string;
  price: string;
  free: boolean;
}

export default function RepPos() {
  const [products, setProducts] = useState<import("@/pwa/sync-db").CacheProduct[]>([]);
  const [customers, setCustomers] = useState<import("@/pwa/sync-db").CacheCustomer[]>([]);
  const [prices, setPrices] = useState<Record<string, string>>({});
  const [stock, setStock] = useState<Record<string, string>>({});
  const [search, setSearch] = useState("");
  const [customerId, setCustomerId] = useState<string | null>(null);
  const [isCredit, setIsCredit] = useState(false);
  const [method, setMethod] = useState<"cash" | "bank_transfer" | "card" | "other">("cash");
  const [lines, setLines] = useState<CartLine[]>([]);
  const [queued, setQueued] = useState<string | null>(null);
  const [online, setOnline] = useState(true);
  const [hasCustody, setHasCustody] = useState(true);

  useEffect(() => {
    (async () => {
      const db = repDb();
      setProducts(await db.products.toArray());
      setCustomers(await db.customers.toArray());
      const priceRows = await db.prices.toArray();
      setPrices(Object.fromEntries(priceRows.map((r) => [r.key, r.price])));
      const stockRows = await db.stock.toArray();
      setStock(Object.fromEntries(stockRows.map((r) => [r.productId, r.onHand])));
      const me = await kvGet<{ custodyWarehouseId: string | null }>("me");
      setHasCustody(Boolean(me?.custodyWarehouseId));
      setOnline(navigator.onLine);
      const on = () => setOnline(true);
      const off = () => setOnline(false);
      window.addEventListener("online", on);
      window.addEventListener("offline", off);
    })();
  }, []);

  const priceFor = (p: (typeof products)[number]) =>
    (customerId && prices[`${customerId}:${p.id}`]) || p.salePrice;

  const matches = useMemo(() => {
    const q = search.trim();
    if (!q) return [];
    return products
      .filter((x) => x.nameAr.includes(q) || x.sku.toLowerCase().includes(q.toLowerCase()) || (x.barcode ?? "").includes(q))
      .slice(0, 8);
  }, [search, products]);

  const totals = useMemo(() => {
    const net = lines.reduce((s, l) => s + (l.free ? 0 : (Number(l.qty) || 0) * (Number(l.price) || 0)), 0);
    const vat = net * 0.15;
    return { net, vat, total: net + vat };
  }, [lines]);

  function addLine(p: (typeof products)[number]) {
    setLines((prev) => [...prev, { productId: p.id, name: p.nameAr, qty: "1", price: priceFor(p), free: false }]);
    setSearch("");
  }

  function update(i: number, patch: Partial<CartLine>) {
    setLines((prev) => prev.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  }

  async function queue() {
    const payload = {
      customerId,
      businessDate: todayBusinessDate(),
      isCredit,
      lines: lines.map((l) => ({
        productId: l.productId,
        qtyBase: l.qty,
        unitPrice: l.free ? undefined : l.price,
        lineKind: l.free ? "free" : "normal",
      })),
      paymentLines: isCredit ? [] : [{ method, amount: totals.total.toFixed(2), reference: null }],
    };
    const opId = await enqueueOp("invoice.create", payload, `فاتورة ${totals.total.toFixed(2)} ${t.common.sar}`);
    // decrement local cached stock (approximate; server authoritative)
    const db = repDb();
    for (const l of lines) {
      const s = await db.stock.get(l.productId);
      if (s) await db.stock.put({ ...s, onHand: String(Number(s.onHand) - Number(l.qty)) });
      setStock((prev) => ({
        ...prev,
        [l.productId]: String((Number(prev[l.productId]) || 0) - Number(l.qty)),
      }));
    }
    setLines([]);
    setQueued(opId);
    setTimeout(() => setQueued(null), 5000);
  }

  if (products.length === 0 && customers.length === 0) {
    return (
      <div className="card p-6 text-center text-sm text-muted">
        <h1 className="mb-2 text-xl font-bold text-foreground">{t.rep.posTitle}</h1>
        {t.rep.emptyCatalog}
      </div>
    );
  }

  return (
    <div className="space-y-4 pb-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold">{t.rep.posTitle}</h1>
        {!online && (
          <span className="flex items-center gap-1 rounded-lg bg-danger-soft px-2.5 py-1 text-[11px] font-semibold text-danger">
            <CloudOff className="h-3.5 w-3.5" /> {t.rep.offline}
          </span>
        )}
      </div>

      {queued && (
        <div className="flex items-center gap-2 rounded-xl bg-success-soft px-4 py-2.5 text-sm">
          <CheckCircle2 className="h-4 w-4 text-success" /> {t.rep.queued}{" "}
          <Link href="/rep/sync" className="ms-1 underline">{t.rep.tabSync}</Link>
        </div>
      )}

      <div className="grid grid-cols-2 gap-2">
        <select className="input w-full" value={customerId ?? ""} onChange={(e) => { setCustomerId(e.target.value || null); if (!e.target.value) setIsCredit(false); }}>
          <option value="">{t.rep.walkin}</option>
          {customers.map((c) => (
            <option key={c.id} value={c.id}>{c.nameAr}{c.creditHold ? " ⛔" : ""}</option>
          ))}
        </select>
        <div className="grid grid-cols-2 overflow-hidden rounded-xl border border-border text-xs font-bold">
          <button type="button" onClick={() => setIsCredit(false)}
            className={`py-2.5 ${!isCredit ? "bg-primary text-primary-foreground" : "text-muted"}`}>
            {t.rep.cashSale}
          </button>
          <button type="button" onClick={() => customerId && setIsCredit(true)} disabled={!customerId}
            className={`py-2.5 disabled:opacity-40 ${isCredit ? "bg-primary text-primary-foreground" : "text-muted"}`}>
            {t.rep.creditSale}
          </button>
        </div>
      </div>

      {!isCredit && (
        <div className="grid grid-cols-4 gap-1 rounded-xl bg-surface-2 p-1 text-[11px] font-semibold">
          {(["cash", "bank_transfer", "card", "other"] as const).map((m) => (
            <button key={m} type="button" onClick={() => setMethod(m)}
              className={`rounded-lg py-2 ${method === m ? "bg-primary text-primary-foreground" : "text-muted"}`}>
              {m === "cash" ? t.pos.cash : m === "bank_transfer" ? t.pos.bank : m === "card" ? t.pos.card : t.pos.other}
            </button>
          ))}
        </div>
      )}

      <div className="relative">
        <Search className="pointer-events-none absolute end-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
        <input value={search} onChange={(e) => setSearch(e.target.value)} className="input pe-10"
          placeholder={t.rep.searchPlaceholder}
          aria-label={t.rep.searchPlaceholder}
          onKeyDown={(e) => { if (e.key === "Enter" && matches[0]) { e.preventDefault(); addLine(matches[0]); } }} />
        {matches.length > 0 && (
          <ul className="absolute z-20 mt-1 max-h-72 w-full overflow-auto rounded-xl border border-border bg-surface shadow-xl">
            {matches.map((m) => (
              <li key={m.id}>
                <button type="button" onClick={() => addLine(m)}
                  className="flex w-full items-center justify-between gap-3 px-4 py-3 text-start text-sm hover:bg-primary-soft">
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{m.nameAr}</span>
                    <span className="tnum text-xs text-muted" dir="ltr">{m.sku}</span>
                  </span>
                  <span className="flex shrink-0 gap-2 text-xs">
                    <span className="tnum font-bold text-primary" dir="ltr">{priceFor(m)}</span>
                    <span className={`tnum ${Number(stock[m.id] ?? "0") > 0 ? "text-muted" : "text-danger"}`} dir="ltr">
                      {Number(stock[m.id] ?? "0")}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="space-y-2">
        {lines.length === 0 ? (
          <div className="card grid place-items-center p-8 text-sm text-muted">
            <ShoppingCart className="mb-2 h-8 w-8 opacity-40" /> {t.pos.emptyCart}
          </div>
        ) : (
          lines.map((l, i) => (
            <div key={i} className="card p-3">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold">{l.name}</p>
                  <p className="tnum text-[11px] text-muted" dir="ltr">{stock[l.productId] ?? "0"}</p>
                </div>
                <div className="flex items-center gap-1">
                  <button type="button" onClick={() => update(i, { free: !l.free })}
                    className={`rounded-lg p-1.5 ${l.free ? "bg-success-soft text-success" : "text-muted hover:bg-surface-2"}`}>
                    <Gift className="h-4 w-4" />
                  </button>
                  <button type="button" onClick={() => setLines((p) => p.filter((_, idx) => idx !== i))}
                    className="rounded-lg p-1.5 text-muted hover:bg-danger-soft hover:text-danger">
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </div>
              <div className="mt-2 grid grid-cols-3 gap-2">
                <div className="flex items-center justify-center gap-1">
                  <button type="button" className="rounded-lg border border-border p-1"
                    onClick={() => update(i, { qty: String(Math.max(1, Number(l.qty) - 1)) })}>
                    <Minus className="h-4 w-4" />
                  </button>
                  <input dir="ltr" inputMode="decimal" className="tnum w-12 rounded-lg border border-input bg-surface py-1 text-center"
                    value={l.qty} onChange={(e) => update(i, { qty: e.target.value.replace(/[^0-9.]/g, "") })} />
                  <button type="button" className="rounded-lg border border-border p-1"
                    onClick={() => update(i, { qty: String(Number(l.qty) + 1) })}>
                    <Plus className="h-4 w-4" />
                  </button>
                </div>
                <input dir="ltr" inputMode="decimal" disabled={l.free}
                  className="tnum rounded-lg border border-input bg-surface py-1.5 text-center disabled:opacity-50"
                  value={l.free ? "0" : l.price}
                  onChange={(e) => update(i, { price: e.target.value.replace(/[^0-9.]/g, "") })} />
                <div className="tnum grid place-items-center text-sm font-bold text-primary" dir="ltr">
                  {l.free ? "0.00" : ((Number(l.qty) || 0) * (Number(l.price) || 0)).toFixed(2)}
                </div>
              </div>
            </div>
          ))
        )}
      </div>

      <div className="card sticky bottom-20 space-y-2 p-4">
        <div className="flex justify-between text-sm">
          <span className="text-muted">{t.pos.subtotal}</span>
          <span className="tnum" dir="ltr">{totals.net.toFixed(2)}</span>
        </div>
        <div className="flex justify-between text-sm">
          <span className="text-muted">{t.pos.vat}</span>
          <span className="tnum" dir="ltr">{totals.vat.toFixed(2)}</span>
        </div>
        <div className="flex items-baseline justify-between border-t border-border pt-2">
          <span className="font-bold">{t.pos.total}</span>
          <span className="tnum text-2xl font-bold text-primary" dir="ltr">{totals.total.toFixed(2)}</span>
        </div>
        {(() => {
          const selected = customers.find((c) => c.id === customerId);
          const standardOfflineBlocked = Boolean(selected?.taxNumber) && !online;
          return (
            <>
              <button type="button" onClick={queue}
                disabled={lines.length === 0 || !hasCustody || standardOfflineBlocked}
                className="btn btn-primary w-full !py-3.5 text-base disabled:opacity-40">
                {t.rep.queueInvoice}
              </button>
              {standardOfflineBlocked && (
                <p className="rounded-xl bg-warning-soft px-4 py-2.5 text-center text-xs leading-relaxed text-warning">
                  فاتورة ضريبية قياسية (عميل مسجّل): الإصدار يتطلب اتصالاً لالتخليص.
                  تُحفظ مسودة محلية — لا تُسلَّم كمستند نهائي حتى الاتصال.
                </p>
              )}
            </>
          );
        })()}
        <p className="text-center text-[10px] text-muted">{t.rep.roughStockWarn}</p>
      </div>
    </div>
  );
}
