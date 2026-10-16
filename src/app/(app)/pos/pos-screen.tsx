"use client";

import { useMemo, useRef, useState, useEffect } from "react";
import { saveInvoiceAction, type InvoiceActionResult } from "@/modules/sales/actions";
import { newId } from "@/modules/shared/ids";
import type { Dict } from "@/i18n";
import {
  Search, ShoppingCart, Trash2, Plus, Minus, X, CheckCircle2,
  AlertCircle, UserRound, Gift, BadgePercent, CreditCard, Banknote,
} from "lucide-react";

interface CustomerOpt {
  id: string;
  label: string;
  creditHold: boolean;
  creditLimit: string;
  terms: number;
}
interface ProductOpt {
  id: string;
  sku: string;
  barcode: string;
  name: string;
  price: string;
  min: string | null;
  max: string | null;
}
interface CartLine {
  productId: string;
  name: string;
  sku: string;
  qty: string;
  price: string;
  free: boolean;
  discount: string;
  overrideReason: string;
}

interface Props {
  t: Dict;
  errors: Record<string, string>;
  customers: CustomerOpt[];
  products: ProductOpt[];
  customerPrices: Record<string, string>;
  balances: Record<string, number>;
  warehouses: { id: string; name: string }[];
  defaultWarehouseId: string;
  treasuries: { id: string; name: string; kind: string }[];
  canPost: boolean;
  canOverride: boolean;
}

export function PosScreen(p: Props) {
  const { t } = p;
  const [customerId, setCustomerId] = useState<string | null>(null);
  const [warehouseId, setWarehouseId] = useState(p.defaultWarehouseId);
  const [isCredit, setIsCredit] = useState(false);
  const [search, setSearch] = useState("");
  const [lines, setLines] = useState<CartLine[]>([]);
  const [dialog, setDialog] = useState(false);
  const [method, setMethod] = useState<"cash" | "bank_transfer" | "card" | "other">("cash");
  const [tendered, setTendered] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; title: string; detail?: string } | null>(null);
  const [opId, setOpId] = useState(() => newId());
  const searchRef = useRef<HTMLInputElement>(null);

  const customer = p.customers.find((c) => c.id === customerId) ?? null;

  const priceFor = (prod: ProductOpt) =>
    (customerId && p.customerPrices[`${customerId}:${prod.id}`]) || prod.price;

  const matches = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return [];
    return p.products
      .filter((x) => x.name.toLowerCase().includes(q) || x.sku.toLowerCase().includes(q) || x.barcode.includes(q))
      .slice(0, 8);
  }, [search, p.products]);

  function addLine(prod: ProductOpt) {
    setLines((prev) => {
      const existing = prev.find((l) => l.productId === prod.id && !l.free);
      if (existing) {
        return prev.map((l) =>
          l === existing ? { ...l, qty: String(Number(l.qty) + 1) } : l,
        );
      }
      return [
        ...prev,
        { productId: prod.id, name: prod.name, sku: prod.sku, qty: "1", price: priceFor(prod), free: false, discount: "0", overrideReason: "" },
      ];
    });
    setSearch("");
    searchRef.current?.focus();
  }

  function update(i: number, patch: Partial<CartLine>) {
    setLines((prev) => prev.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  }

  const totals = useMemo(() => {
    let net = 0;
    for (const l of lines) {
      if (l.free) continue;
      net += (Number(l.qty) || 0) * (Number(l.price) || 0) - (Number(l.discount) || 0);
    }
    net = Math.max(0, net);
    const vat = net * 0.15;
    return { net, vat, total: net + vat };
  }, [lines]);

  const defaultTendered = totals.total.toFixed(2);
  const paid = Number(tendered || defaultTendered) || 0;
  const remainder = Math.max(0, totals.total - paid);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.ctrlKey && e.key === "Enter" && lines.length > 0 && !result) {
        e.preventDefault();
        setTendered(defaultTendered);
        setDialog(true);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [lines.length, defaultTendered, result]);

  useEffect(() => {
    searchRef.current?.focus();
  }, [result]);

  async function save(intent: "draft" | "post") {
    setBusy(true);
    setResult(null);
    try {
      const paidLines = isCredit
        ? []
        : [{ method, amount: (tendered || defaultTendered), treasuryAccountId: p.treasuries[0]?.id ?? null, reference: null }];
      const res: InvoiceActionResult = await saveInvoiceAction(formData(intent, paidLines));
      if (res.ok) {
        setResult({
          ok: true,
          title: intent === "post" ? `${t.pos.invoiceSaved} #${res.invoiceNo}` : t.pos.draftSaved,
        });
        setLines([]);
        setDialog(false);
        setCustomerId(null);
        setIsCredit(false);
        setTendered("");
        setOpId(newId());
      } else {
        const key = res.errorKey?.split(".")[1] ?? "unexpected";
        setResult({ ok: false, title: p.errors[key] ?? p.errors.unexpected });
        setDialog(false);
      }
    } catch {
      setResult({ ok: false, title: p.errors.unexpected });
      setDialog(false);
    } finally {
      setBusy(false);
    }
  }

  function formData(intent: "draft" | "post", paymentLines: unknown[]): FormData {
    const fd = new FormData();
    fd.set("customerId", customerId ?? "");
    fd.set("warehouseId", warehouseId);
    fd.set("businessDate", new Date().toISOString().slice(0, 10));
    fd.set("isCredit", String(isCredit));
    fd.set("clientOpId", opId);
    fd.set("intent", intent);
    fd.set(
      "linesJson",
      JSON.stringify(
        lines.map((l) => ({
          productId: l.productId,
          qtyBase: l.qty,
          unitPrice: l.free ? undefined : l.price,
          lineKind: l.free ? ("free" as const) : ("normal" as const),
          discountAmount: l.free ? "0" : l.discount || "0",
          overrideReason: l.overrideReason || undefined,
        })),
      ),
    );
    if (paymentLines.length > 0) fd.set("paymentLinesJson", JSON.stringify(paymentLines));
    return fd;
  }

  const stockOf = (productId: string) => p.balances[`${warehouseId}:${productId}`] ?? 0;

  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_360px]">
      {/* right (cart) */}
      <section className="card flex min-h-[70vh] flex-col p-5">
        <h1 className="sr-only">{t.nav.pos}</h1>
      <div className="flex flex-wrap items-center gap-3 border-b border-border pb-4">
          <label className="flex min-w-52 flex-1 items-center gap-2">
            <UserRound className="h-4 w-4 shrink-0 text-muted" />
            <select
              className="input"
              value={customerId ?? ""}
              onChange={(e) => {
                setCustomerId(e.target.value || null);
                if (!e.target.value) setIsCredit(false);
              }}
            >
              <option value="">{t.pos.walkin}</option>
              {p.customers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}{c.creditHold ? " ⛔" : ""}
                </option>
              ))}
            </select>
          </label>
          <div className="flex overflow-hidden rounded-xl border border-border text-sm font-semibold">
            <button
              type="button"
              onClick={() => setIsCredit(false)}
              className={`px-4 py-2.5 ${!isCredit ? "bg-primary text-primary-foreground" : "text-muted hover:bg-surface-2"}`}
            >
              {t.pos.cashSale}
            </button>
            <button
              type="button"
              onClick={() => customerId && setIsCredit(true)}
              disabled={!customerId}
              title={!customerId ? t.pos.walkin : undefined}
              className={`px-4 py-2.5 disabled:opacity-40 ${isCredit ? "bg-primary text-primary-foreground" : "text-muted hover:bg-surface-2"}`}
            >
              {t.pos.creditSale}
            </button>
          </div>
          <select aria-label={t.inventory.warehouse} className="input w-auto" value={warehouseId}
            onChange={(e) => setWarehouseId(e.target.value)}>
            {p.warehouses.map((w) => (
              <option key={w.id} value={w.id}>{w.name}</option>
            ))}
          </select>
        </div>

        <div className="relative mt-4">
          <Search className="pointer-events-none absolute end-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
          <input
            ref={searchRef}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && matches[0]) {
                e.preventDefault();
                addLine(matches[0]);
              }
            }}
            className="input pe-10"
            placeholder={t.pos.searchPlaceholder}
            aria-label={t.pos.searchPlaceholder}
          />
          {matches.length > 0 && (
            <ul className="absolute z-20 mt-1 max-h-64 w-full overflow-auto rounded-xl border border-border bg-surface shadow-xl">
              {matches.map((m) => (
                <li key={m.id}>
                  <button
                    type="button"
                    onClick={() => addLine(m)}
                    className="flex w-full items-center justify-between gap-3 px-4 py-2.5 text-start text-sm hover:bg-primary-soft"
                  >
                    <span className="min-w-0">
                      <span className="block truncate font-medium">{m.name}</span>
                      <span className="tnum text-xs text-muted" dir="ltr">{m.sku} · {m.barcode || "—"}</span>
                    </span>
                    <span className="flex shrink-0 items-center gap-3 text-xs">
                      <span className="tnum font-bold text-primary" dir="ltr">{priceFor(m)}</span>
                      <span className={`tnum ${stockOf(m.id) > 0 ? "text-muted" : "text-danger"}`}>
                        {stockOf(m.id)}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* cart */}
        <div className="mt-4 flex-1 overflow-x-auto">
          {lines.length === 0 ? (
            <div className="grid h-full place-items-center text-muted">
              <div className="text-center">
                <ShoppingCart className="mx-auto mb-3 h-10 w-10 opacity-40" />
                <p className="text-sm">{t.pos.emptyCart}</p>
              </div>
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-xs text-muted">
                  <th className="py-2 text-start font-medium">{t.pos.product}</th>
                  <th className="w-28 py-2 text-center font-medium">{t.pos.qty}</th>
                  <th className="w-24 py-2 text-end font-medium">{t.pos.price}</th>
                  <th className="w-20 py-2 text-end font-medium">{t.pos.discount}</th>
                  <th className="w-24 py-2 text-end font-medium">{t.pos.lineTotal}</th>
                  <th className="w-16" />
                </tr>
              </thead>
              <tbody>
                {lines.map((l, i) => {
                  const base = Number(l.qty) * Number(l.price);
                  const lineTotal = l.free ? 0 : Math.max(0, base - Number(l.discount || 0));
                  const prod = p.products.find((x) => x.id === l.productId);
                  const outOfBand =
                    !l.free && prod &&
                    ((prod.min && Number(l.price) < Number(prod.min)) ||
                      (prod.max && Number(l.price) > Number(prod.max)));
                  return (
                    <tr key={i} className="border-b border-border/60">
                      <td className="py-2 pe-2">
                        <p className="font-medium leading-tight">{l.name}</p>
                        <p className="tnum text-[11px] text-muted" dir="ltr">{l.sku} · {t.pos.remaining}: {stockOf(l.productId)}</p>
                        {outOfBand && (
                          <input
                            className="mt-1 input !py-1 text-xs"
                            placeholder={t.pos.overrideReasonPlaceholder}
                            value={l.overrideReason}
                            onChange={(e) => update(i, { overrideReason: e.target.value })}
                          />
                        )}
                      </td>
                      <td className="py-2">
                        <div className="mx-auto flex w-fit items-center gap-1">
                          <button type="button" className="rounded-lg border border-border p-1 hover:bg-surface-2"
                            onClick={() => update(i, { qty: String(Math.max(1, Number(l.qty) - 1)) })}>
                            <Minus className="h-3.5 w-3.5" />
                          </button>
                          <input
                            dir="ltr" inputMode="decimal"
                            className="tnum w-14 rounded-lg border border-input bg-surface py-1 text-center text-sm"
                            value={l.qty}
                            onChange={(e) => update(i, { qty: e.target.value.replace(/[^0-9.]/g, "") })}
                          />
                          <button type="button" className="rounded-lg border border-border p-1 hover:bg-surface-2"
                            onClick={() => update(i, { qty: String(Number(l.qty) + 1) })}>
                            <Plus className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </td>
                      <td className="py-2">
                        <input
                          dir="ltr" inputMode="decimal" disabled={l.free}
                          className={`tnum w-full rounded-lg border bg-surface py-1 text-end text-sm disabled:opacity-50 ${outOfBand ? "border-warning" : "border-border"}`}
                          value={l.free ? "0" : l.price}
                          onChange={(e) => update(i, { price: e.target.value.replace(/[^0-9.]/g, "") })}
                          title={outOfBand ? t.pos.boundaryHint : undefined}
                        />
                      </td>
                      <td className="py-2">
                        <input
                          dir="ltr" inputMode="decimal" disabled={l.free}
                          className="tnum w-full rounded-lg border border-input bg-surface py-1 text-end text-sm disabled:opacity-50"
                          value={l.free ? "0" : l.discount}
                          onChange={(e) => update(i, { discount: e.target.value.replace(/[^0-9.]/g, "") })}
                        />
                      </td>
                      <td className="tnum py-2 text-end font-semibold" dir="ltr">{lineTotal.toFixed(2)}</td>
                      <td className="py-2 text-end">
                        <div className="flex items-center justify-end gap-1">
                          <button
                            type="button"
                            onClick={() => update(i, { free: !l.free })}
                            title={t.pos.free}
                            className={`rounded-lg p-1.5 ${l.free ? "bg-success-soft text-success" : "text-muted hover:bg-surface-2"}`}
                          >
                            <Gift className="h-4 w-4" />
                          </button>
                          <button type="button" onClick={() => setLines((prev) => prev.filter((_, idx) => idx !== i))}
                            className="rounded-lg p-1.5 text-muted hover:bg-danger-soft hover:text-danger">
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        <div className="flex items-center justify-between border-t border-border pt-3">
          <button type="button" onClick={() => setLines([])} className="btn btn-ghost text-danger" disabled={lines.length === 0}>
            {t.pos.clear}
          </button>
          <span className="text-xs text-muted">{lines.length} {t.pos.lines}</span>
        </div>
      </section>

      {/* totals side */}
      <aside className="card flex h-fit flex-col gap-3 p-5">
        <h2 className="font-semibold">{t.pos.summaryInvoice}</h2>
        <dl className="space-y-2 border-b border-border pb-3 text-sm">
          <div className="flex justify-between">
            <dt className="text-muted">{t.pos.subtotal}</dt>
            <dd className="tnum font-semibold" dir="ltr">{totals.net.toFixed(2)}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-muted">{t.pos.vat}</dt>
            <dd className="tnum" dir="ltr">{totals.vat.toFixed(2)}</dd>
          </div>
        </dl>
        <div className="flex items-baseline justify-between">
          <span className="font-bold">{t.pos.total}</span>
          <span className="tnum text-3xl font-bold text-primary" dir="ltr">{totals.total.toFixed(2)}</span>
        </div>
        <button
          type="button"
          disabled={lines.length === 0}
          onClick={() => {
            setTendered(defaultTendered);
            setDialog(true);
          }}
          className="btn btn-primary w-full !py-3 text-base disabled:opacity-40"
        >
          {t.pos.checkout}
        </button>

        {result && (
          <div role="status" className={`flex items-start gap-2 rounded-xl px-4 py-3 text-sm ${result.ok ? "bg-success-soft" : "bg-danger-soft"}`}>
            {result.ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" /> : <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-danger" />}
            <span>{result.title}</span>
          </div>
        )}
      </aside>

      {/* save dialog */}
      {dialog && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4 backdrop-blur-sm" onClick={() => !busy && setDialog(false)}>
          <div className="card w-full max-w-md p-6 shadow-2xl" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={t.pos.saveTitle}>
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-bold">{t.pos.saveTitle}</h3>
              <button type="button" onClick={() => setDialog(false)} className="rounded-lg p-1.5 text-muted hover:bg-surface-2">
                <X className="h-5 w-5" />
              </button>
            </div>

            <dl className="mt-4 space-y-2 rounded-xl bg-surface-2 p-4 text-sm">
              <div className="flex justify-between"><dt className="text-muted">{t.pos.customer}</dt><dd className="font-medium">{customer?.label ?? t.pos.walkin}</dd></div>
              <div className="flex justify-between"><dt className="text-muted">{t.pos.lines}</dt><dd>{lines.length}</dd></div>
              <div className="flex justify-between"><dt className="text-muted">{t.pos.vat}</dt><dd className="tnum" dir="ltr">{totals.vat.toFixed(2)}</dd></div>
              <div className="flex justify-between text-base font-bold"><dt>{t.pos.total}</dt><dd className="tnum text-primary" dir="ltr">{totals.total.toFixed(2)}</dd></div>
              {lines.some((l) => l.free) && (
                <div className="flex items-center gap-1.5 pt-1 text-xs text-success">
                  <Gift className="h-3.5 w-3.5" />
                  {lines.filter((l) => l.free).length} {t.pos.free}
                </div>
              )}
            </dl>

            {isCredit ? (
              <p className="mt-3 rounded-xl bg-info-soft px-4 py-2.5 text-xs leading-relaxed text-foreground/80">
                <BadgePercent className="me-1 inline h-4 w-4" /> {t.pos.creditNote}
              </p>
            ) : (
              <div className="mt-4 space-y-3">
                <div className="grid grid-cols-4 gap-1 overflow-hidden rounded-xl bg-surface-2 p-1 text-xs font-semibold">
                  {(["cash", "bank_transfer", "card", "other"] as const).map((m) => (
                    <button key={m} type="button" onClick={() => setMethod(m)}
                      className={`rounded-lg px-2 py-2 ${method === m ? "bg-primary text-primary-foreground" : "text-muted hover:bg-surface-3"}`}>
                      {m === "cash" ? t.pos.cash : m === "bank_transfer" ? t.pos.bank : m === "card" ? t.pos.card : t.pos.other}
                    </button>
                  ))}
                </div>
                <label className="block text-sm">
                  <span className="mb-1 block font-medium">{t.pos.tendered}</span>
                  <input
                    dir="ltr" inputMode="decimal" autoFocus
                    className="input tnum text-end text-lg font-bold"
                    value={tendered}
                    onChange={(e) => setTendered(e.target.value.replace(/[^0-9.]/g, ""))}
                  />
                </label>
                {remainder > 0.004 && (
                  <p className="text-xs text-warning">{t.pos.remaining}: <span className="tnum font-bold" dir="ltr">{remainder.toFixed(2)}</span></p>
                )}
                {method === "card" && (
                  <p className="flex items-start gap-1.5 rounded-xl bg-warning-soft px-4 py-2.5 text-xs leading-relaxed">
                    <CreditCard className="mt-0.5 h-4 w-4 shrink-0 text-warning" /> {t.pos.cardNote}
                  </p>
                )}
              </div>
            )}

            <div className="mt-5 space-y-2">
              {p.canPost ? (
                <button type="button" disabled={busy} onClick={() => save("post")}
                  className="btn btn-primary w-full !py-3 text-base disabled:opacity-50">
                  <Banknote className="h-5 w-5" /> {t.pos.saveAndPost}
                </button>
              ) : (
                <p className="rounded-xl bg-warning-soft px-4 py-2 text-center text-xs">{t.pos.postingBlocked}</p>
              )}
              <button type="button" disabled={busy} onClick={() => save("draft")}
                className="btn btn-ghost w-full border border-border disabled:opacity-50">
                {t.pos.saveDraft}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
