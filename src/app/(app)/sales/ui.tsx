"use client";

import { useState } from "react";
import {
  createReceiptAction,
  applyAdvanceAction,
  createReturnAction,
} from "@/modules/sales/actions";
import type { Dict } from "@/i18n";
import { AlertCircle, CheckCircle2, RotateCcw } from "lucide-react";

function ResultBox({ result }: { result: { ok: boolean; text: string } | null }) {
  if (!result) return null;
  return (
    <div role="status" className={`mt-3 flex items-start gap-2 rounded-xl px-4 py-2.5 text-sm ${result.ok ? "bg-success-soft" : "bg-danger-soft"}`}>
      {result.ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 text-success" /> : <AlertCircle className="mt-0.5 h-4 w-4 text-danger" />}
      <span>{result.text}</span>
    </div>
  );
}

/** Receipt capture with allocation to an open invoice (INV-09 server-guarded). */
export function ReceiptForm({
  t,
  errors,
  customers,
  openInvoices,
}: {
  t: Dict;
  errors: Record<string, string>;
  customers: { id: string; label: string }[];
  openInvoices: { id: string; customerId: string; label: string; outstanding: string }[];
}) {
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [customerId, setCustomerId] = useState("");
  const [method, setMethod] = useState<"cash" | "bank_transfer" | "card" | "other">("cash");
  const [amount, setAmount] = useState("");
  const [reference, setReference] = useState("");
  const [invoiceId, setInvoiceId] = useState("");
  const [useAdvance, setUseAdvance] = useState("");

  const filtered = openInvoices.filter((i) => i.customerId === customerId);
  const selected = filtered.find((i) => i.id === invoiceId);

  async function submit() {
    setPending(true);
    setResult(null);
    try {
      const allocAmount = amount || selected?.outstanding || "0";
      const fd = new FormData();
      fd.set("customerId", customerId);
      fd.set("businessDate", new Date().toISOString().slice(0, 10));
      fd.set("paymentLinesJson", JSON.stringify([{ method, amount, reference: reference || null }]));
      fd.set(
        "allocationsJson",
        JSON.stringify(invoiceId ? [{ invoiceId, amount: allocAmount }] : []),
      );
      const res = await createReceiptAction(fd);

      if (res.ok && useAdvance && Number(useAdvance) > 0 && invoiceId) {
        const advFd = new FormData();
        advFd.set("customerId", customerId);
        advFd.set("invoiceId", invoiceId);
        advFd.set("amount", useAdvance);
        const adv = await applyAdvanceAction(advFd);
        if (!adv.ok) {
          const key = adv.errorKey?.split(".")[1] ?? "unexpected";
          setResult({ ok: false, text: errors[key] ?? errors.unexpected });
          setPending(false);
          return;
        }
      }
      const key = res.errorKey?.split(".")[1] ?? "unexpected";
      setResult(res.ok ? { ok: true, text: t.salesPg.receiptSaved } : { ok: false, text: errors[key] ?? errors.unexpected });
      if (res.ok) { setAmount(""); setReference(""); setUseAdvance(""); }
    } finally {
      setPending(false);
    }
  }

  const labelCls = "block text-sm";
  const spanCls = "mb-1 block font-medium";

  return (
    <section className="card space-y-4 p-5">
      <h2 className="font-semibold">{t.salesPg.receive}</h2>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <label className={labelCls}>
          <span className={spanCls}>{t.salesPg.customer}</span>
          <select className="input" value={customerId} onChange={(e) => { setCustomerId(e.target.value); setInvoiceId(""); }}>
            <option value="">—</option>
            {customers.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
          </select>
        </label>
        <label className={labelCls}>
          <span className={spanCls}>{t.salesPg.allocateTo}</span>
          <select className="input" value={invoiceId} onChange={(e) => setInvoiceId(e.target.value)} disabled={!customerId}>
            <option value="">{t.salesPg.advance}</option>
            {filtered.map((i) => (
              <option key={i.id} value={i.id}>{i.label}</option>
            ))}
          </select>
        </label>
        <label className={labelCls}>
          <span className={spanCls}>{t.salesPg.method}</span>
          <select className="input" value={method} onChange={(e) => setMethod(e.target.value as typeof method)}>
            <option value="cash">{t.pos.cash}</option>
            <option value="bank_transfer">{t.pos.bank}</option>
            <option value="card">{t.pos.card}</option>
            <option value="other">{t.pos.other}</option>
          </select>
        </label>
        <label className={labelCls}>
          <span className={spanCls}>{t.salesPg.amount}</span>
          <input dir="ltr" inputMode="decimal" className="input tnum text-end" value={amount}
            placeholder={selected ? Number(selected.outstanding).toFixed(2) : "0.00"}
            onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} />
        </label>
        <label className={labelCls}>
          <span className={spanCls}>{t.salesPg.reference}</span>
          <input className="input" value={reference} onChange={(e) => setReference(e.target.value)} placeholder="—" />
        </label>
        {invoiceId && (
          <label className={labelCls}>
            <span className={spanCls}>{t.salesPg.useAdvance}</span>
            <input dir="ltr" inputMode="decimal" className="input tnum text-end" value={useAdvance}
              placeholder="0.00"
              onChange={(e) => setUseAdvance(e.target.value.replace(/[^0-9.]/g, ""))} />
          </label>
        )}
      </div>
      <button type="button" onClick={submit} className="btn btn-primary"
        disabled={pending || !customerId || !amount}>
        {pending ? t.common.loading : t.salesPg.apply}
      </button>
      <ResultBox result={result} />
    </section>
  );
}

/** Inline return-quantity capture per invoice (issues a posted credit note). */
export function ReturnInline({
  t,
  errors,
  invoiceId,
  lines,
}: {
  t: Dict;
  errors: Record<string, string>;
  invoiceId: string;
  lines: { lineId: string; productName: string; sold: string; returned: string }[];
}) {
  const [open, setOpen] = useState(false);
  const [qty, setQty] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  if (lines.length === 0 && !open) return null;

  async function submit() {
    setPending(true);
    setResult(null);
    try {
      const perLineQty = Object.fromEntries(Object.entries(qty).filter(([, v]) => Number(v) > 0));
      const fd = new FormData();
      fd.set("originalInvoiceId", invoiceId);
      fd.set("perLineQtyJson", JSON.stringify(perLineQty));
      const res = await createReturnAction(fd);
      const key = res.errorKey?.split(".")[1] ?? "unexpected";
      setResult(res.ok ? { ok: true, text: `${t.salesPg.returnDone} #${res.invoiceNo}` } : { ok: false, text: errors[key] ?? errors.unexpected });
      if (res.ok) setOpen(false);
    } finally {
      setPending(false);
    }
  }

  return (
    <span className="inline-block text-start">
      <button type="button" onClick={() => setOpen((o) => !o)} className="btn btn-ghost !px-3 !py-1.5 text-xs text-info">
        <RotateCcw className="h-3.5 w-3.5" /> {t.salesPg.returnTitle}
      </button>
      {open && (
        <span className="absolute z-30 mt-1 block w-72 rounded-xl border border-border bg-surface p-4 shadow-xl">
          <span className="mb-2 block text-xs font-semibold text-muted">{t.salesPg.returnQty}</span>
          <span className="block space-y-2">
            {lines.map((l) => {
              const remaining = Number(l.sold) - Number(l.returned);
              return (
                <span key={l.lineId} className="flex items-center justify-between gap-2 text-xs">
                  <span className="min-w-0 flex-1 truncate">{l.productName}</span>
                  <span className="tnum text-muted" dir="ltr">{remaining}</span>
                  <input
                    dir="ltr" inputMode="decimal"
                    className="tnum w-16 rounded-lg border border-border bg-surface px-1.5 py-1 text-end"
                    placeholder="0"
                    value={qty[l.lineId] ?? ""}
                    onChange={(e) => setQty((q) => ({ ...q, [l.lineId]: e.target.value.replace(/[^0-9.]/g, "") }))}
                  />
                </span>
              );
            })}
          </span>
          <button
            type="button"
            onClick={submit}
            disabled={pending || !Object.values(qty).some((v) => Number(v) > 0)}
            className="btn btn-primary mt-3 w-full !py-2 text-xs disabled:opacity-40"
          >
            {pending ? t.common.loading : t.salesPg.returnApply}
          </button>
          <ResultBox result={result} />
        </span>
      )}
    </span>
  );
}
