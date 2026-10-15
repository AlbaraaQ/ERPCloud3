"use client";

import { useState } from "react";
import {
  createBomAction, createOrderAction, startOrderAction, addComponentAction,
  recordScrapAction, completeOrderAction, cancelOrderAction, traceRecallAction,
  type RecallTraceResult,
} from "@/modules/manufacturing/actions";
import { ActionButton } from "@/components/forms/action-button";
import type { Dict } from "@/i18n";
import { Plus, Trash2, AlertCircle, CheckCircle2, FlaskConical, PackageCheck } from "lucide-react";

interface Opt { id: string; label: string }

function ResultBox({ result }: { result: { ok: boolean; text: string } | null }) {
  if (!result) return null;
  return (
    <div role="status" className={`mt-3 flex items-start gap-2 rounded-xl px-4 py-2.5 text-sm ${result.ok ? "bg-success-soft" : "bg-danger-soft"}`}>
      {result.ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 text-success" /> : <AlertCircle className="mt-0.5 h-4 w-4 text-danger" />}
      <span>{result.text}</span>
    </div>
  );
}

function errText(errors: Record<string, string>, key?: string) {
  return errors[key?.split(".")[1] ?? "unexpected"] ?? errors.unexpected;
}

/** BOM builder. */
export function BomForm({ t, errors, products }: { t: Dict; errors: Record<string, string>; products: Opt[] }) {
  const [productId, setProductId] = useState("");
  const [name, setName] = useState("");
  const [yieldQty, setYieldQty] = useState("10");
  const [lines, setLines] = useState([{ productId: "", qty: "1" }]);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  async function submit() {
    setBusy(true);
    setResult(null);
    try {
      const fd = new FormData();
      fd.set("productId", productId);
      fd.set("name", name);
      fd.set("yieldQty", yieldQty);
      fd.set("linesJson", JSON.stringify(lines.filter((l) => l.productId && Number(l.qty) > 0)));
      const res = await createBomAction(fd);
      setResult(res.ok ? { ok: true, text: t.mfg.bomSaved } : { ok: false, text: errText(errors, res.errorKey) });
      if (res.ok) { setName(""); setLines([{ productId: "", qty: "1" }]); }
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card space-y-4 p-5">
      <h3 className="font-semibold">{t.mfg.newBom}</h3>
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="block text-sm">
          <span className="mb-1 block font-medium">{t.mfg.product}</span>
          <select className="input" value={productId} onChange={(e) => setProductId(e.target.value)}>
            <option value="">—</option>
            {products.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
          </select>
        </label>
        <label className="block text-sm">
          <span className="mb-1 block font-medium">الاسم</span>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="وصفة …" />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block font-medium">{t.mfg.yieldQty}</span>
          <input dir="ltr" inputMode="decimal" className="input tnum text-end" value={yieldQty} onChange={(e) => setYieldQty(e.target.value.replace(/[^0-9.]/g, ""))} />
        </label>
      </div>
      {lines.map((l, i) => (
        <div key={i} className="grid grid-cols-[1fr_120px_36px] items-center gap-2">
          <select className="input !py-2" value={l.productId} onChange={(e) => setLines((p) => p.map((x, idx) => (idx === i ? { ...x, productId: e.target.value } : x)))}>
            <option value="">{t.mfg.addComponent}…</option>
            {products.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
          </select>
          <input dir="ltr" inputMode="decimal" className="input tnum !py-2 text-end" value={l.qty}
            onChange={(e) => setLines((p) => p.map((x, idx) => (idx === i ? { ...x, qty: e.target.value.replace(/[^0-9.]/g, "") } : x)))} />
          <button type="button" onClick={() => setLines((p) => p.filter((_, idx) => idx !== i))}
            className="rounded-lg p-2 text-muted hover:bg-danger-soft hover:text-danger">
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      ))}
      <div className="flex items-center justify-between">
        <button type="button" onClick={() => setLines((p) => [...p, { productId: "", qty: "1" }])}
          className="btn btn-ghost !px-3 !py-1.5 text-xs text-primary">
          <Plus className="h-3.5 w-3.5" /> {t.mfg.addComponent}
        </button>
        <button type="button" onClick={submit} disabled={busy || !productId || !name || lines.every((l) => !l.productId)}
          className="btn btn-primary disabled:opacity-40">
          {busy ? t.common.loading : t.common.save}
        </button>
      </div>
      <ResultBox result={result} />
    </section>
  );
}

/** New production order (short inline). */
export function OrderForm({ t, errors, boms, warehouses }: { t: Dict; errors: Record<string, string>; boms: Opt[]; warehouses: Opt[] }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    setBusy(true);
    setResult(null);
    try {
      const res = await createOrderAction(fd);
      setResult(res.ok ? { ok: true, text: `✓ #${(res as { orderId?: string }).orderId?.slice(0, 8)}` } : { ok: false, text: errText(errors, res.errorKey) });
      if (res.ok) (e.target as HTMLFormElement).reset();
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="card space-y-3 p-5">
      <h3 className="font-semibold">{t.mfg.newOrder}</h3>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <select name="bomId" required className="input">
          <option value="">{t.mfg.bom}…</option>
          {boms.map((b) => <option key={b.id} value={b.id}>{b.label}</option>)}
        </select>
        <input name="plannedQty" required dir="ltr" inputMode="decimal" className="input tnum text-end" placeholder={t.mfg.plannedQty} />
        <select name="fromWarehouseId" required className="input">
          <option value="">{t.mfg.fromWh}…</option>
          {warehouses.map((w) => <option key={w.id} value={w.id}>{w.label}</option>)}
        </select>
        <select name="toWarehouseId" required className="input">
          <option value="">{t.mfg.toWh}…</option>
          {warehouses.map((w) => <option key={w.id} value={w.id}>{w.label}</option>)}
        </select>
      </div>
      <button type="submit" disabled={busy} className="btn btn-primary">{t.common.save}</button>
      <ResultBox result={result} />
    </form>
  );
}

/* ------------------------------------------------------------------ order detail */
export interface OrderView {
  id: string;
  orderNo: number | null;
  status: string;
  plannedQty: string;
  outputQty: string | null;
  productName: string;
  consumedValue: number;
  componentsValue: number;
  clearing: number;
  yieldPct: string | null;
  outputCost: string | null;
}
export interface PlanLine {
  bomLineId: string;
  productName: string;
  plannedQty: string;
  actualQty: string;
}

export function OrderCard({
  t, errors, order, planLines, components, consumables,
}: {
  t: Dict;
  errors: Record<string, string>;
  order: OrderView;
  planLines: PlanLine[];
  components: { id: string; kind: string; description: string | null; amount: string }[];
  consumables: { bomLineId: string | null; productId: string; productName: string; plannedQty: string; actualQty: string; costValue: string }[];
}) {
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [componentForm, setComponentForm] = useState({ kind: "labor", amount: "", description: "" });
  const [scrapForm, setScrapForm] = useState({ productId: "", qty: "", abnormal: false });
  const [completeForm, setCompleteForm] = useState({ qty: order.plannedQty, expiry: "" });

  async function run(fn: () => Promise<{ ok: boolean; errorKey?: string }>, okText: string) {
    setBusy(true);
    setResult(null);
    try {
      const res = await fn();
      setResult(res.ok ? { ok: true, text: okText } : { ok: false, text: errText(errors, res.errorKey) });
      return res.ok;
    } finally {
      setBusy(false);
    }
  }

  const statusLabel = (s: string) =>
    s === "planned" ? t.mfg.stPlanned : s === "in_progress" ? t.mfg.stProgress : s === "completed" ? t.mfg.stCompleted : t.mfg.stCancelled;

  return (
    <section className="card space-y-4 p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="font-bold">
            {t.mfg.orderNo} #{order.orderNo ?? "—"} — {order.productName}
          </p>
          <p className="text-xs text-muted">
            {statusLabel(order.status)} · {t.mfg.plannedQty}: <span className="tnum" dir="ltr">{Number(order.plannedQty)}</span>
            {order.outputQty && <> · {t.mfg.outputQty}: <span className="tnum" dir="ltr">{Number(order.outputQty)}</span> ({order.yieldPct}%)</>}
          </p>
        </div>
        <span className={`rounded-lg px-2.5 py-1 text-[11px] font-semibold ${order.status === "completed" ? "bg-success-soft text-success" : order.status === "in_progress" ? "bg-info-soft text-info" : "bg-surface-3 text-muted"}`}>
          {statusLabel(order.status)}
        </span>
      </div>

      {result && <ResultBox result={result} />}

      {/* plan / consumption */}
      {(order.status === "planned" || order.status === "in_progress") && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-xs text-muted">
                <th className="py-2 text-start font-medium">{t.mfg.consumePlan}</th>
                <th className="w-24 py-2 text-end font-medium">{t.mfg.planned}</th>
                <th className="w-28 py-2 text-end font-medium">{order.status === "planned" ? t.mfg.actual : t.mfg.actual}</th>
                {order.status === "in_progress" && <th className="w-24 py-2 text-end font-medium">{t.mfg.journalValue}</th>}
              </tr>
            </thead>
            <tbody>
              {order.status === "planned"
                ? planLines.map((l) => (
                    <tr key={l.bomLineId} className="border-b border-border/60">
                      <td className="py-2">{l.productName}</td>
                      <td className="tnum py-2 text-end" dir="ltr">{Number(l.plannedQty).toFixed(3)}</td>
                      <td className="py-2 text-end">
                        <input dir="ltr" inputMode="decimal" className="tnum w-24 rounded-lg border border-border bg-surface py-1 text-end"
                          defaultValue={Number(l.actualQty).toFixed(3)}
                          onChange={(e) => setOverrides((o) => ({ ...o, [l.bomLineId]: e.target.value.replace(/[^0-9.]/g, "") || String(l.actualQty) }))} />
                      </td>
                    </tr>
                  ))
                : consumables.map((c, i) => (
                    <tr key={i} className="border-b border-border/60">
                      <td className="py-2">{c.productName}</td>
                      <td className="tnum py-2 text-end text-muted" dir="ltr">{Number(c.plannedQty).toFixed(3)}</td>
                      <td className="tnum py-2 text-end font-semibold" dir="ltr">{Number(c.actualQty).toFixed(3)}</td>
                      <td className="tnum py-2 text-end font-semibold text-primary" dir="ltr">{Number(c.costValue).toFixed(2)}</td>
                    </tr>
                  ))}
            </tbody>
          </table>
        </div>
      )}

      {order.status === "planned" && (
        <div className="flex gap-2">
          <ActionButton
            label={t.mfg.start}
            action={startOrderAction}
            fields={{ orderId: order.id, overridesJson: JSON.stringify(overrides) }}
            confirmText={t.mfg.startConfirm}
            okText={t.mfg.startDone}
            errors={errors}
          />
          <ActionButton label={t.mfg.cancel} action={cancelOrderAction} fields={{ orderId: order.id }}
            variant="ghost" okText="✓" errors={errors} />
        </div>
      )}

      {order.status === "in_progress" && (
        <>
          {/* components */}
          <div className="space-y-2">
            <h4 className="text-sm font-semibold">{t.mfg.costComponents}</h4>
            {components.map((c) => (
              <div key={c.id} className="flex items-center justify-between rounded-lg bg-surface-2 px-3 py-2 text-sm">
                <span>{c.description} ({c.kind === "labor" ? t.mfg.labor : c.kind === "overhead" ? t.mfg.overhead : t.mfg.other})</span>
                <span className="tnum font-semibold" dir="ltr">{Number(c.amount).toFixed(2)}</span>
              </div>
            ))}
            <div className="grid grid-cols-[110px_1fr_130px_auto] gap-2">
              <select className="input !py-2" value={componentForm.kind} onChange={(e) => setComponentForm((f) => ({ ...f, kind: e.target.value }))}>
                <option value="labor">{t.mfg.labor}</option>
                <option value="overhead">{t.mfg.overhead}</option>
                <option value="other">{t.mfg.other}</option>
              </select>
              <input className="input !py-2" placeholder="الوصف" value={componentForm.description}
                onChange={(e) => setComponentForm((f) => ({ ...f, description: e.target.value }))} />
              <input dir="ltr" inputMode="decimal" className="input tnum !py-2 text-end" placeholder={t.mfg.amount}
                value={componentForm.amount}
                onChange={(e) => setComponentForm((f) => ({ ...f, amount: e.target.value.replace(/[^0-9.]/g, "") }))} />
              <button
                type="button"
                disabled={busy || !componentForm.amount || !componentForm.description}
                onClick={() =>
                  void run(() => {
                    const fd = new FormData();
                    fd.set("orderId", order.id);
                    fd.set("kind", componentForm.kind);
                    fd.set("description", componentForm.description);
                    fd.set("amount", componentForm.amount);
                    return addComponentAction(fd);
                  }, "✓")
                }
                className="btn btn-ghost border border-border !px-3 !py-1.5 text-xs"
              >
                {t.mfg.addCost}
              </button>
            </div>
          </div>

          {/* scrap */}
          <details className="rounded-xl border border-border p-3">
            <summary className="cursor-pointer text-sm font-semibold text-danger">{t.mfg.recordScrap}</summary>
            <div className="mt-3 grid grid-cols-[1fr_110px_110px_auto] items-center gap-2">
              <select className="input !py-2" value={scrapForm.productId} onChange={(e) => setScrapForm((f) => ({ ...f, productId: e.target.value }))}>
                <option value="">—</option>
                {consumables.map((c, i) => (
                  <option key={i} value={c.productId}>{c.productName}</option>
                ))}
              </select>
              <input dir="ltr" inputMode="decimal" className="input tnum !py-2 text-end" placeholder={t.inventory.qty}
                value={scrapForm.qty} onChange={(e) => setScrapForm((f) => ({ ...f, qty: e.target.value.replace(/[^0-9.]/g, "") }))} />
              <select className="input !py-2" value={String(scrapForm.abnormal)} onChange={(e) => setScrapForm((f) => ({ ...f, abnormal: e.target.value === "true" }))}>
                <option value="false">{t.mfg.normal}</option>
                <option value="true">{t.mfg.abnormal}</option>
              </select>
              <button
                type="button"
                disabled={busy || !scrapForm.productId || !scrapForm.qty}
                onClick={() =>
                  void run(() => {
                    const fd = new FormData();
                    fd.set("orderId", order.id);
                    fd.set("productId", scrapForm.productId);
                    fd.set("qty", scrapForm.qty);
                    fd.set("abnormal", String(scrapForm.abnormal));
                    return recordScrapAction(fd);
                  }, "✓")
                }
                className="btn btn-ghost border border-danger/40 !px-3 !py-1.5 text-xs text-danger"
              >
                {t.mfg.recordScrap}
              </button>
            </div>
          </details>

          {/* complete */}
          <div className="rounded-2xl border border-primary/30 bg-primary-soft/40 p-4">
            <p className="mb-2 text-sm font-semibold">{t.mfg.complete}</p>
            <div className="grid grid-cols-[1fr_1fr_auto] items-end gap-3">
              <label className="block text-xs">
                <span className="mb-1 block font-medium">{t.mfg.outputQty}</span>
                <input dir="ltr" inputMode="decimal" className="input tnum text-end" value={completeForm.qty}
                  onChange={(e) => setCompleteForm((f) => ({ ...f, qty: e.target.value.replace(/[^0-9.]/g, "") }))} />
              </label>
              <label className="block text-xs">
                <span className="mb-1 block font-medium">{t.mfg.expiry}</span>
                <input type="date" className="input" value={completeForm.expiry}
                  onChange={(e) => setCompleteForm((f) => ({ ...f, expiry: e.target.value }))} />
              </label>
              <button
                type="button"
                disabled={busy || !completeForm.qty}
                onClick={() => {
                  if (!window.confirm(t.mfg.completeConfirm)) return;
                  void run(() => {
                    const fd = new FormData();
                    fd.set("orderId", order.id);
                    fd.set("outputQty", completeForm.qty);
                    fd.set("expiryDate", completeForm.expiry);
                    return completeOrderAction(fd);
                  }, "✓");
                }}
                className="btn btn-primary"
              >
                <PackageCheck className="h-4 w-4" /> {t.mfg.complete}
              </button>
            </div>
          </div>
        </>
      )}

      {order.status === "completed" && (
        <div className="grid gap-3 sm:grid-cols-4">
          <div className="rounded-xl bg-surface-2 p-3 text-center">
            <p className="tnum text-lg font-bold" dir="ltr">{order.consumedValue.toFixed(2)}</p>
            <p className="text-[11px] text-muted">{t.mfg.materials}</p>
          </div>
          <div className="rounded-xl bg-surface-2 p-3 text-center">
            <p className="tnum text-lg font-bold" dir="ltr">{order.componentsValue.toFixed(2)}</p>
            <p className="text-[11px] text-muted">{t.mfg.components}</p>
          </div>
          <div className="rounded-xl bg-surface-2 p-3 text-center">
            <p className="tnum text-lg font-bold text-primary" dir="ltr">{order.outputCost}</p>
            <p className="text-[11px] text-muted">{t.mfg.unitCost}</p>
          </div>
          <div className="rounded-xl bg-surface-2 p-3 text-center">
            <p className="tnum text-lg font-bold" dir="ltr">{order.yieldPct}%</p>
            <p className="text-[11px] text-muted">{t.mfg.yieldPct}</p>
          </div>
        </div>
      )}
    </section>
  );
}

/** Recall trace widget. */
export function RecallTrace({ t, errors }: { t: Dict; errors: Record<string, string> }) {
  const [lotId, setLotId] = useState("");
  const [result, setResult] = useState<RecallTraceResult | null>(null);
  const [busy, setBusy] = useState(false);

  async function trace() {
    setBusy(true);
    setResult(null);
    try {
      const res = await traceRecallAction(lotId.trim());
      setResult(res);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card space-y-3 p-5">
      <h3 className="flex items-center gap-2 font-semibold"><FlaskConical className="h-4 w-4 text-primary" /> {t.mfg.recall}</h3>
      <p className="text-xs text-muted">{t.mfg.recallHint}</p>
      <div className="flex gap-2">
        <input dir="ltr" className="input flex-1" placeholder="lot uuid…" value={lotId} onChange={(e) => setLotId(e.target.value)} />
        <button type="button" onClick={trace} disabled={busy || !lotId.trim()} className="btn btn-primary disabled:opacity-40">
          {busy ? t.common.loading : t.mfg.trace}
        </button>
      </div>
      {result && (result.errorKey ? (
        <p className="text-sm text-danger">{errText(errors, result.errorKey)}</p>
      ) : result.output ? (
        <div className="space-y-3 text-sm">
          <div className="rounded-xl bg-primary-soft p-3">
            <p className="font-semibold">{t.mfg.batch}: {String(result.output.batch_no)}</p>
            <p className="text-xs">{String(result.output.product_name)} · {t.mfg.unitCost}: <span className="tnum" dir="ltr">{Number(String(result.output.unit_cost)).toFixed(4)}</span></p>
          </div>
          {result.consumedLots.length > 0 && (
            <div>
              <p className="mb-1 font-semibold">{t.mfg.consumedLots}</p>
              <ul className="space-y-1">
                {result.consumedLots.map((l, i) => (
                  <li key={i} className="flex justify-between rounded-lg bg-surface-2 px-3 py-1.5 text-xs">
                    <span>{String(l.product_name)}</span>
                    <span className="tnum" dir="ltr">{String(l.batch_no)} · {Number(String(l.qty)).toFixed(3)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {result.sales.length > 0 && (
            <div>
              <p className="mb-1 font-semibold">{t.mfg.sales}</p>
              <ul className="space-y-1">
                {result.sales.map((s, i) => (
                  <li key={i} className="flex justify-between rounded-lg bg-surface-2 px-3 py-1.5 text-xs">
                    <span>#{String(s.invoice_no)} — {String(s.customer_name ?? "عميل عابر")}</span>
                    <span className="tnum" dir="ltr">{String(s.business_date)} · {Number(String(s.qty)).toFixed(2)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      ) : (
        <p className="text-sm text-muted">{t.common.empty}</p>
      ))}
    </section>
  );
}
