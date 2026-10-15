"use client";

import { useMemo, useState } from "react";
import {
  createPurchaseInvoiceAction,
  createSupplierPaymentAction,
} from "@/modules/purchasing/actions";
import type { Dict } from "@/i18n";
import { Plus, Trash2, AlertCircle, CheckCircle2 } from "lucide-react";

function ResultBox({ result }: { result: { ok: boolean; text: string } | null }) {
  if (!result) return null;
  return (
    <div role="status" className={`mt-3 flex items-start gap-2 rounded-xl px-4 py-2.5 text-sm ${result.ok ? "bg-success-soft" : "bg-danger-soft"}`}>
      {result.ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 text-success" /> : <AlertCircle className="mt-0.5 h-4 w-4 text-danger" />}
      <span>{result.text}</span>
    </div>
  );
}

interface Opt { id: string; label: string }

interface Line {
  productId: string;
  qty: string;
  cost: string;
  batchNo: string;
  expiry: string;
}

export function PurchaseForm({
  t, errors, suppliers, warehouses, products,
}: { t: Dict; errors: Record<string, string>; suppliers: Opt[]; warehouses: Opt[]; products: Opt[] }) {
  const [lines, setLines] = useState<Line[]>([{ productId: "", qty: "", cost: "", batchNo: "", expiry: "" }]);
  const [supplierId, setSupplierId] = useState("");
  const [supplierRef, setSupplierRef] = useState("");
  const [warehouseId, setWarehouseId] = useState(warehouses[0]?.id ?? "");
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  const totals = useMemo(() => {
    const net = lines.reduce((s, l) => s + (Number(l.qty) || 0) * (Number(l.cost) || 0), 0);
    return { net, vat: net * 0.15, total: net * 1.15 };
  }, [lines]);

  function update(i: number, patch: Partial<Line>) {
    setLines((prev) => prev.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  }

  async function submit() {
    setPending(true);
    setResult(null);
    try {
      const fd = new FormData();
      fd.set("supplierId", supplierId);
      fd.set("supplierRef", supplierRef);
      fd.set("warehouseId", warehouseId);
      fd.set("businessDate", new Date().toISOString().slice(0, 10));
      fd.set(
        "linesJson",
        JSON.stringify(
          lines
            .filter((l) => l.productId && Number(l.qty) > 0)
            .map((l) => ({
              productId: l.productId,
              qtyBase: l.qty,
              unitCost: l.cost,
              batchNo: l.batchNo || null,
              expiryDate: l.expiry || null,
            })),
        ),
      );
      const res = await createPurchaseInvoiceAction(fd);
      const key = res.errorKey?.split(".")[1] ?? "unexpected";
      setResult(res.ok
        ? { ok: true, text: `${t.purchasing.created} #${res.invoiceNo ?? ""}` }
        : { ok: false, text: errors[key] ?? errors.unexpected });
      if (res.ok) setLines([{ productId: "", qty: "", cost: "", batchNo: "", expiry: "" }]);
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="card space-y-4 p-5">
      <h2 className="font-semibold">{t.purchasing.newInvoice}</h2>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <label className="block text-sm">
          <span className="mb-1 block font-medium">{t.purchasing.supplier}</span>
          <select className="input" value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
            <option value="">—</option>
            {suppliers.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
        </label>
        <label className="block text-sm">
          <span className="mb-1 block font-medium">{t.purchasing.supplierRef}</span>
          <input className="input" value={supplierRef} onChange={(e) => setSupplierRef(e.target.value)} />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block font-medium">{t.purchasing.warehouse}</span>
          <select className="input" value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
            {warehouses.map((w) => <option key={w.id} value={w.id}>{w.label}</option>)}
          </select>
        </label>
      </div>

      <div className="space-y-2">
        {lines.map((l, i) => (
          <div key={i} className="grid items-end gap-2 rounded-xl border border-border p-3 sm:grid-cols-[1fr_100px_110px_120px_140px_36px]">
            <select className="input !py-2" value={l.productId} onChange={(e) => update(i, { productId: e.target.value })}>
              <option value="">{t.purchasing.product}…</option>
              {products.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select>
            <input className="input tnum !py-2 text-end" dir="ltr" inputMode="decimal" placeholder={t.purchasing.qty}
              value={l.qty} onChange={(e) => update(i, { qty: e.target.value.replace(/[^0-9.]/g, "") })} />
            <input className="input tnum !py-2 text-end" dir="ltr" inputMode="decimal" placeholder={t.purchasing.cost}
              value={l.cost} onChange={(e) => update(i, { cost: e.target.value.replace(/[^0-9.]/g, "") })} />
            <input className="input !py-2" placeholder={t.purchasing.batch} value={l.batchNo} onChange={(e) => update(i, { batchNo: e.target.value })} />
            <input type="date" className="input !py-2" value={l.expiry} onChange={(e) => update(i, { expiry: e.target.value })} />
            <button type="button" onClick={() => setLines((p) => p.filter((_, idx) => idx !== i))}
              className="rounded-lg p-2 text-muted hover:bg-danger-soft hover:text-danger">
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <button type="button" onClick={() => setLines((p) => [...p, { productId: "", qty: "", cost: "", batchNo: "", expiry: "" }])}
          className="btn btn-ghost !px-3 !py-1.5 text-xs text-primary">
          <Plus className="h-3.5 w-3.5" /> {t.purchasing.addLine}
        </button>
        <div className="tnum text-sm" dir="ltr">
          {t.purchasing.net}: <b>{totals.net.toFixed(2)}</b> · {t.purchasing.vat}: <b>{totals.vat.toFixed(2)}</b> · {t.purchasing.total}: <b className="text-primary">{totals.total.toFixed(2)}</b>
        </div>
      </div>

      <button type="button" onClick={submit} className="btn btn-primary"
        disabled={pending || !supplierId || !lines.some((l) => l.productId && Number(l.qty) > 0)}>
        {pending ? t.common.loading : t.purchasing.save}
      </button>
      <ResultBox result={result} />
    </section>
  );
}

export function SupplierPaymentForm({
  t, errors, suppliers, treasuries, openInvoices,
}: {
  t: Dict; errors: Record<string, string>; suppliers: Opt[]; treasuries: Opt[];
  openInvoices: { id: string; supplierId: string; label: string }[];
}) {
  const [supplierId, setSupplierId] = useState("");
  const [invoiceId, setInvoiceId] = useState("");
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<"cash" | "bank_transfer" | "card" | "other">("cash");
  const [treasuryId, setTreasuryId] = useState(treasuries[0]?.id ?? "");
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const filtered = openInvoices.filter((i) => i.supplierId === supplierId);

  async function submit() {
    setPending(true);
    setResult(null);
    try {
      const fd = new FormData();
      fd.set("supplierId", supplierId);
      fd.set("method", method);
      fd.set("treasuryAccountId", treasuryId);
      fd.set("amount", amount);
      fd.set("businessDate", new Date().toISOString().slice(0, 10));
      fd.set("allocationsJson", JSON.stringify(invoiceId ? [{ purchaseInvoiceId: invoiceId, amount }] : []));
      const res = await createSupplierPaymentAction(fd);
      const key = res.errorKey?.split(".")[1] ?? "unexpected";
      setResult(res.ok
        ? { ok: true, text: `${t.purchasing.paymentSaved} #${res.paymentNo ?? ""}` }
        : { ok: false, text: errors[key] ?? errors.unexpected });
      if (res.ok) setAmount("");
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="card space-y-4 p-5">
      <h2 className="font-semibold">{t.purchasing.pay}</h2>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <label className="block text-sm">
          <span className="mb-1 block font-medium">{t.purchasing.supplier}</span>
          <select className="input" value={supplierId} onChange={(e) => { setSupplierId(e.target.value); setInvoiceId(""); }}>
            <option value="">—</option>
            {suppliers.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
        </label>
        <label className="block text-sm">
          <span className="mb-1 block font-medium">{t.salesPg.allocateTo}</span>
          <select className="input" value={invoiceId} onChange={(e) => setInvoiceId(e.target.value)} disabled={!supplierId}>
            <option value="">—</option>
            {filtered.map((i) => <option key={i.id} value={i.id}>{i.label}</option>)}
          </select>
        </label>
        <label className="block text-sm">
          <span className="mb-1 block font-medium">{t.salesPg.method}</span>
          <select className="input" value={method} onChange={(e) => setMethod(e.target.value as typeof method)}>
            <option value="cash">{t.pos.cash}</option>
            <option value="bank_transfer">{t.pos.bank}</option>
          </select>
        </label>
        <label className="block text-sm">
          <span className="mb-1 block font-medium">{t.cashPg.account}</span>
          <select className="input" value={treasuryId} onChange={(e) => setTreasuryId(e.target.value)}>
            {treasuries.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
          </select>
        </label>
        <label className="block text-sm">
          <span className="mb-1 block font-medium">{t.salesPg.amount}</span>
          <input dir="ltr" inputMode="decimal" className="input tnum text-end" value={amount}
            onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} placeholder="0.00" />
        </label>
      </div>
      <button type="button" onClick={submit} className="btn btn-primary" disabled={pending || !supplierId || !amount}>
        {pending ? t.common.loading : t.salesPg.apply}
      </button>
      <ResultBox result={result} />
    </section>
  );
}
