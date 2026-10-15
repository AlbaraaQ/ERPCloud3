"use client";

import { useState } from "react";
import type { ReactNode } from "react";
import {
  receiveStockAction,
  createProductAction,
  dispatchTransferFlowAction,
} from "@/modules/inventory/actions";
import type { ActionResult } from "@/modules/shared/action-result";
import type { Dict } from "@/i18n";
import { AlertCircle, CheckCircle2 } from "lucide-react";

interface Opt {
  id: string;
  label: string;
}
interface BaseProps {
  t: Dict;
  errors: Record<string, string>;
}

function useSubmit() {
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  return { pending, result, setPending, setResult };
}

function ResultBox({ result }: { result: { ok: boolean; text: string } | null }) {
  if (!result) return null;
  return (
    <div role="status" className={`mt-3 flex items-start gap-2 rounded-xl px-4 py-2.5 text-sm ${result.ok ? "bg-success-soft" : "bg-danger-soft"}`}>
      {result.ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 text-success" /> : <AlertCircle className="mt-0.5 h-4 w-4 text-danger" />}
      <span>{result.text}</span>
    </div>
  );
}

async function callAndReport(
  res: ActionResult,
  t: Dict,
  errors: Record<string, string>,
  okKey: keyof Dict["inventory"],
  setResult: (r: { ok: boolean; text: string } | null) => void,
) {
  if (res.ok) setResult({ ok: true, text: t.inventory[okKey] });
  else {
    const key = res.errorKey?.split(".")[1] ?? "unexpected";
    setResult({ ok: false, text: errors[key] ?? errors.unexpected });
  }
}

function Field({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block font-medium">{label}</span>
      {children}
    </label>
  );
}

/** Stock receipt form (inventory.adjust permission). */
export function ReceiptForm({ t, errors, warehouses, products }: BaseProps & { warehouses: Opt[]; products: Opt[] }) {
  const { pending, result, setPending, setResult } = useSubmit();
  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    setPending(true);
    setResult(null);
    try {
      const res = await receiveStockAction(new FormData(form));
      await callAndReport(res, t, errors, "receiptDone", setResult);
      if (res.ok) form.reset();
    } finally {
      setPending(false);
    }
  }
  return (
    <form onSubmit={onSubmit} className="card p-5">
      <h3 className="mb-3 font-semibold">{t.inventory.receipt}</h3>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Field label={t.inventory.warehouse}>
          <select name="warehouseId" required className="input">
            {warehouses.map((w) => (<option key={w.id} value={w.id}>{w.label}</option>))}
          </select>
        </Field>
        <Field label={t.inventory.product}>
          <select name="productId" required className="input">
            {products.map((p) => (<option key={p.id} value={p.id}>{p.label}</option>))}
          </select>
        </Field>
        <Field label={t.inventory.qty}>
          <input name="qty" required dir="ltr" inputMode="decimal" className="input tnum text-end" placeholder="0.00" />
        </Field>
        <Field label={t.inventory.cost}>
          <input name="cost" required dir="ltr" inputMode="decimal" className="input tnum text-end" placeholder="0.00" />
        </Field>
        <Field label={t.inventory.batchNo}>
          <input name="batchNo" className="input" placeholder="—" />
        </Field>
        <Field label={t.inventory.expiry}>
          <input name="expiry" type="date" className="input" />
        </Field>
      </div>
      <button type="submit" className="btn btn-primary mt-4" disabled={pending}>
        {pending ? t.common.loading : t.inventory.submit}
      </button>
      <ResultBox result={result} />
    </form>
  );
}

/** Product creation (catalog.products.manage permission). */
export function ProductForm({ t, errors, units }: BaseProps & { units: Opt[] }) {
  const { pending, result, setPending, setResult } = useSubmit();
  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    setPending(true);
    setResult(null);
    try {
      const res = await createProductAction(new FormData(form));
      await callAndReport(res, t, errors, "productCreated", setResult);
      if (res.ok) form.reset();
    } finally {
      setPending(false);
    }
  }
  return (
    <form onSubmit={onSubmit} className="card p-5">
      <h3 className="mb-3 font-semibold">{t.inventory.newProduct}</h3>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field label={t.inventory.sku}>
          <input name="sku" required dir="ltr" className="input" placeholder="SKU-001" />
        </Field>
        <Field label={t.inventory.barcode}>
          <input name="barcode" dir="ltr" className="input" />
        </Field>
        <Field label={t.inventory.name}>
          <input name="nameAr" required className="input" />
        </Field>
        <Field label={t.inventory.unit}>
          <select name="stockUnitId" required className="input">
            {units.map((u) => (<option key={u.id} value={u.id}>{u.label}</option>))}
          </select>
        </Field>
        <Field label={t.inventory.price}>
          <input name="salePrice" dir="ltr" inputMode="decimal" className="input tnum text-end" placeholder="0.00" />
        </Field>
        <Field label={t.inventory.minPrice}>
          <input name="minPrice" dir="ltr" inputMode="decimal" className="input tnum text-end" placeholder="—" />
        </Field>
        <Field label={t.inventory.maxPrice}>
          <input name="maxPrice" dir="ltr" inputMode="decimal" className="input tnum text-end" placeholder="—" />
        </Field>
        <div className="flex items-end gap-4 pb-1 text-sm">
          <label className="flex items-center gap-2">
            <input type="checkbox" name="trackLots" className="h-4 w-4 accent-[var(--primary)]" />
            {t.inventory.trackLots}
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" name="trackExpiry" className="h-4 w-4 accent-[var(--primary)]" />
            {t.inventory.trackExpiry}
          </label>
        </div>
      </div>
      <button type="submit" className="btn btn-primary mt-4" disabled={pending}>
        {pending ? t.common.loading : t.common.save}
      </button>
      <ResultBox result={result} />
    </form>
  );
}

/** Transfer dispatch (inventory.transfer.dispatch permission). */
export function DispatchForm({ t, errors, warehouses, products }: BaseProps & { warehouses: Opt[]; products: Opt[] }) {
  const { pending, result, setPending, setResult } = useSubmit();
  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    setPending(true);
    setResult(null);
    try {
      const res = await dispatchTransferFlowAction(new FormData(form));
      await callAndReport(res, t, errors, "transferCreated", setResult);
      if (res.ok) form.reset();
    } finally {
      setPending(false);
    }
  }
  return (
    <form onSubmit={onSubmit} className="card p-5">
      <h3 className="mb-3 font-semibold">{t.inventory.newTransfer}</h3>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <Field label={t.inventory.from}>
          <select name="fromWarehouseId" required className="input">
            {warehouses.map((w) => (<option key={w.id} value={w.id}>{w.label}</option>))}
          </select>
        </Field>
        <Field label={t.inventory.to}>
          <select name="toWarehouseId" required className="input">
            {warehouses.map((w) => (<option key={w.id} value={w.id}>{w.label}</option>))}
          </select>
        </Field>
        <Field label={t.inventory.product}>
          <select name="productId" required className="input">
            {products.map((p) => (<option key={p.id} value={p.id}>{p.label}</option>))}
          </select>
        </Field>
        <Field label={t.inventory.qty}>
          <input name="qty" required dir="ltr" inputMode="decimal" className="input tnum text-end" placeholder="0.00" />
        </Field>
        <div className="flex items-end">
          <button type="submit" className="btn btn-primary w-full" disabled={pending}>
            {pending ? t.common.loading : t.inventory.submit}
          </button>
        </div>
      </div>
      <ResultBox result={result} />
    </form>
  );
}
