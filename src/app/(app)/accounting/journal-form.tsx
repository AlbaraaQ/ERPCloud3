"use client";

import { useMemo, useState } from "react";
import { createJournalAction } from "@/modules/accounting/actions";
import type { ActionResult } from "@/modules/shared/action-result";
import type { Dict } from "@/i18n";
import { Plus, Trash2, AlertCircle, CheckCircle2 } from "lucide-react";

interface AccountOption {
  id: string;
  code: string;
  name: string;
}

interface Line {
  accountId: string;
  debit: string;
  credit: string;
}

const emptyLine = (): Line => ({ accountId: "", debit: "", credit: "" });

export function JournalForm({ t, accounts, defaultDate, errors }: { t: Dict; accounts: AccountOption[]; defaultDate: string; errors: Record<string, string> }) {
  const [businessDate, setBusinessDate] = useState(defaultDate);
  const [memo, setMemo] = useState("");
  const [lines, setLines] = useState<Line[]>([emptyLine(), emptyLine()]);
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  const totals = useMemo(() => {
    const dr = lines.reduce((s, l) => s + (parseFloat(l.debit) || 0), 0);
    const cr = lines.reduce((s, l) => s + (parseFloat(l.credit) || 0), 0);
    return { dr, cr, balanced: Math.abs(dr - cr) < 0.0001 && dr > 0 };
  }, [lines]);

  function update(i: number, patch: Partial<Line>) {
    setLines((prev) => prev.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  }

  async function submit(intent: "draft" | "post") {
    setPending(true);
    setResult(null);
    try {
      const fd = new FormData();
      fd.set("businessDate", businessDate);
      fd.set("memo", memo);
      fd.set("intent", intent);
      fd.set(
        "linesJson",
        JSON.stringify(
          lines
            .filter((l) => l.accountId && (parseFloat(l.debit) > 0 || parseFloat(l.credit) > 0))
            .map((l) => ({ accountId: l.accountId, debit: l.debit || "0", credit: l.credit || "0" })),
        ),
      );
      const res: ActionResult = await createJournalAction(fd);
      if (res.ok) {
        setResult({ ok: true, text: intent === "post" ? t.accounting.journalPosted : t.accounting.journalCreated });
        setLines([emptyLine(), emptyLine()]);
        setMemo("");
      } else {
        const key = res.errorKey?.split(".")[1] ?? "unexpected";
        setResult({ ok: false, text: errors[key] ?? errors.unexpected });
      }
    } catch {
      setResult({ ok: false, text: errors.unexpected });
    } finally {
      setPending(false);
    }
  }

  const opt = (a: AccountOption) => (
    <option key={a.id} value={a.id}>
      {a.code} — {a.name}
    </option>
  );

  return (
    <div className="card p-6">
      <h3 className="font-semibold">{t.accounting.newJournal}</h3>

      {result && (
        <div role="status" className={`mt-3 flex items-start gap-2 rounded-xl px-4 py-3 text-sm ${result.ok ? "bg-success-soft" : "bg-danger-soft"}`}>
          {result.ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 text-success" /> : <AlertCircle className="mt-0.5 h-4 w-4 text-danger" />}
          <span>{result.text}</span>
        </div>
      )}

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <label className="block text-sm">
          <span className="mb-1 block font-medium">{t.accounting.date}</span>
          <input type="date" className="input" value={businessDate} onChange={(e) => setBusinessDate(e.target.value)} />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block font-medium">{t.accounting.memo}</span>
          <input className="input" value={memo} onChange={(e) => setMemo(e.target.value)} maxLength={500} />
        </label>
      </div>

      <div className="mt-4 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-xs text-muted">
              <th className="py-2 text-start font-medium">{t.accounting.account}</th>
              <th className="w-36 py-2 text-end font-medium">{t.accounting.debit}</th>
              <th className="w-36 py-2 text-end font-medium">{t.accounting.credit}</th>
              <th className="w-10" />
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={i} className="border-b border-border/60">
                <td className="py-1.5 pe-2">
                  <select aria-label={`${t.accounting.account} ${i + 1}`} className="input" value={l.accountId}
                    onChange={(e) => update(i, { accountId: e.target.value })}>
                    <option value="">—</option>
                    {accounts.map(opt)}
                  </select>
                </td>
                <td className="py-1.5 px-1">
                  <input aria-label={`${t.accounting.debit} ${i + 1}`} dir="ltr" inputMode="decimal" className="input tnum text-end" value={l.debit}
                    onChange={(e) => update(i, { debit: e.target.value.replace(/[^0-9.]/g, ""), credit: e.target.value ? "0" : l.credit })} placeholder="0.00" />
                </td>
                <td className="py-1.5 px-1">
                  <input aria-label={`${t.accounting.credit} ${i + 1}`} dir="ltr" inputMode="decimal" className="input tnum text-end" value={l.credit}
                    onChange={(e) => update(i, { credit: e.target.value.replace(/[^0-9.]/g, ""), debit: e.target.value ? "0" : l.debit })} placeholder="0.00" />
                </td>
                <td className="py-1.5 text-center">
                  <button type="button" onClick={() => setLines((p) => p.filter((_, idx) => idx !== i))}
                    className="rounded-lg p-1.5 text-muted hover:bg-danger-soft hover:text-danger" title={t.accounting.removeLine} aria-label={t.accounting.removeLine}>
                    <Trash2 className="h-4 w-4" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td className="py-2">
                <button type="button" onClick={() => setLines((p) => [...p, emptyLine()])} className="btn btn-ghost !px-3 !py-1.5 text-xs text-primary">
                  <Plus className="h-3.5 w-3.5" /> {t.accounting.addLine}
                </button>
              </td>
              <td className="tnum py-2 text-end font-bold" dir="ltr">{totals.dr.toFixed(2)}</td>
              <td className="tnum py-2 text-end font-bold" dir="ltr">{totals.cr.toFixed(2)}</td>
              <td />
            </tr>
          </tfoot>
        </table>
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <span className={`rounded-lg px-3 py-1.5 text-xs font-semibold ${totals.balanced ? "bg-success-soft text-success" : "bg-warning-soft text-warning"}`}>
          {totals.balanced ? t.accounting.balanced : `${t.accounting.notBalanced} (${t.accounting.difference}: ${(totals.dr - totals.cr).toFixed(2)})`}
        </span>
        <div className="flex gap-2">
          <button type="button" onClick={() => submit("draft")} disabled={pending || !totals.balanced} className="btn btn-ghost border border-border disabled:opacity-50">
            {t.accounting.saveDraft}
          </button>
          <button type="button" onClick={() => submit("post")} disabled={pending || !totals.balanced} className="btn btn-primary disabled:opacity-50">
            {t.accounting.saveAndPost}
          </button>
        </div>
      </div>
    </div>
  );
}
