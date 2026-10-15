"use client";

import { useState } from "react";
import { createExpenseAction } from "@/modules/cash/actions";
import type { Dict } from "@/i18n";
import { AlertCircle, CheckCircle2 } from "lucide-react";

export function ExpenseForm({
  t,
  errors,
  treasuries,
}: {
  t: Dict;
  errors: Record<string, string>;
  treasuries: { id: string; label: string }[];
}) {
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    setPending(true);
    setResult(null);
    try {
      const res = await createExpenseAction(new FormData(form));
      const key = res.errorKey?.split(".")[1] ?? "unexpected";
      setResult(res.ok ? { ok: true, text: t.cashPg.created } : { ok: false, text: errors[key] ?? errors.unexpected });
      if (res.ok) form.reset();
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="card space-y-4 p-5">
      <h2 className="font-semibold">{t.cashPg.newExpense}</h2>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <label className="block text-sm">
          <span className="mb-1 block font-medium">{t.cashPg.category}</span>
          <input name="category" required className="input" placeholder="نقل، وقود، صيانة…" />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block font-medium">{t.cashPg.amount}</span>
          <input name="amount" required dir="ltr" inputMode="decimal" className="input tnum text-end" placeholder="0.00" />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block font-medium">{t.cashPg.method}</span>
          <select name="method" className="input" defaultValue="cash">
            <option value="cash">{t.pos.cash}</option>
            <option value="bank_transfer">{t.pos.bank}</option>
          </select>
        </label>
        <label className="block text-sm">
          <span className="mb-1 block font-medium">{t.cashPg.account}</span>
          <select name="treasuryAccountId" required className="input">
            {treasuries.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
          </select>
        </label>
        <label className="block text-sm">
          <span className="mb-1 block font-medium">{t.cashPg.note}</span>
          <input name="note" className="input" placeholder="—" />
        </label>
      </div>
      <button type="submit" className="btn btn-primary" disabled={pending}>
        {pending ? t.common.loading : t.cashPg.save}
      </button>
      {result && (
        <div role="status" className={`flex items-start gap-2 rounded-xl px-4 py-2.5 text-sm ${result.ok ? "bg-success-soft" : "bg-danger-soft"}`}>
          {result.ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 text-success" /> : <AlertCircle className="mt-0.5 h-4 w-4 text-danger" />}
          <span>{result.text}</span>
        </div>
      )}
    </form>
  );
}
