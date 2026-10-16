"use client";

import { useState } from "react";
import {
  openReviewAction,
  recordCountsAction,
  approveExceptionAction,
  closeSettlementAction,
} from "@/modules/vansales/actions";
import type { Dict } from "@/i18n";
import {
  AlertCircle, CheckCircle2, ChevronDown, ChevronUp, Lock, ShieldCheck,
} from "lucide-react";

interface SettlementInfo {
  id: string;
  settlementNo: number;
  status: string;
  businessDate: string;
  repName: string;
  expectedCash: string | null;
  countedCash: string | null;
}
interface LineInfo {
  productId: string;
  expectedQty: string;
  countedQty: string | null;
}
interface ExceptionInfo {
  id: string;
  kind: string;
  entity: string;
  diff: string | null;
  note: string | null;
  resolution: string;
}

interface Props {
  t: Dict;
  errors: Record<string, string>;
  settlement: SettlementInfo;
  lines: LineInfo[];
  exceptions: ExceptionInfo[];
  canFinalize: boolean;
  canApproveException: boolean;
  statusLabel: string;
}

export function SettlementReview({ t, errors, settlement, lines, exceptions, canFinalize, canApproveException, statusLabel }: Props) {
  const [open, setOpen] = useState(settlement.status !== "requested");
  const [counts, setCounts] = useState<Record<string, string>>(
    Object.fromEntries(lines.map((l) => [l.productId, l.countedQty ?? l.expectedQty])),
  );
  const [cash, setCash] = useState(settlement.countedCash ?? settlement.expectedCash ?? "0");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [status, setStatus] = useState(settlement.status);
  const [exceptionState, setExceptionState] = useState(exceptions);

  const err = (key?: string) => {
    const k = key?.split(".")[1] ?? "unexpected";
    return errors[k] ?? errors.unexpected;
  };

  const pendingExceptions = exceptionState.filter((e) => e.resolution === "pending");

  async function run(fn: () => Promise<{ ok: boolean; errorKey?: string }>, okText: string) {
    setBusy(true);
    setResult(null);
    try {
      const res = await fn();
      setResult(res.ok ? { ok: true, text: okText } : { ok: false, text: err(res.errorKey) });
      return res.ok;
    } finally {
      setBusy(false);
    }
  }

  const entityLabel = (e: string) =>
    e === "stock" ? t.rep.entityStock : e === "cash" ? t.rep.entityCash : t.rep.entityEpay;
  const kindLabel = (k: string) =>
    k === "shortage" ? t.rep.shortage : k === "overage" ? t.rep.overage : t.rep.info;

  const kindTone = (k: string) =>
    k === "shortage" ? "bg-danger-soft text-danger" : k === "overage" ? "bg-info-soft text-info" : "bg-surface-3 text-muted";

  return (
    <section className="card overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between p-4 text-start hover:bg-surface-2"
      >
        <div>
          <p className="font-bold">
            {t.rep.settlementNo} #{settlement.settlementNo}{" "}
            <span className="ms-2 rounded-lg bg-primary-soft px-2 py-0.5 text-[11px] font-semibold text-primary">{statusLabel}</span>
          </p>
          <p className="mt-0.5 text-xs text-muted">
            {settlement.repName} · <span dir="ltr">{settlement.businessDate}</span>
          </p>
        </div>
        {open ? <ChevronUp className="h-5 w-5 text-muted" /> : <ChevronDown className="h-5 w-5 text-muted" />}
      </button>

      {open && (
        <div className="space-y-5 border-t border-border p-5">
          {result && (
            <div role="status" className={`flex items-start gap-2 rounded-xl px-4 py-2.5 text-sm ${result.ok ? "bg-success-soft" : "bg-danger-soft"}`}>
              {result.ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 text-success" /> : <AlertCircle className="mt-0.5 h-4 w-4 text-danger" />}
              <span>{result.text}</span>
            </div>
          )}

          {status === "requested" && (
            <button
              type="button"
              disabled={busy}
              onClick={async () => {
                const ok = await run(() => {
                  const fd = new FormData();
                  fd.set("settlementId", settlement.id);
                  return openReviewAction(fd);
                }, t.rep.sReview);
                if (ok) setStatus("under_review");
              }}
              className="btn btn-primary"
            >
              {t.rep.openReview}
            </button>
          )}

          {status !== "requested" && (
            <>
              {/* cash */}
              <div className="grid gap-3 sm:grid-cols-3">
                <div className="rounded-xl bg-surface-2 p-4">
                  <p className="text-xs text-muted">{t.rep.cashExpected}</p>
                  <p className="tnum text-xl font-bold" dir="ltr">{Number(settlement.expectedCash ?? "0").toFixed(2)}</p>
                </div>
                <label className="rounded-xl border border-border p-4">
                  <span className="mb-1 block text-xs font-medium text-muted">{t.rep.cashCounted}</span>
                  <input dir="ltr" inputMode="decimal" className="tnum w-full bg-transparent text-xl font-bold outline-none"
                    value={cash} onChange={(e) => setCash(e.target.value.replace(/[^0-9.]/g, ""))} />
                </label>
                <div className="rounded-xl bg-surface-2 p-4">
                  <p className="text-xs text-muted">{t.rep.diff}</p>
                  <p className={`tnum text-xl font-bold ${Math.abs(Number(cash) - Number(settlement.expectedCash ?? 0)) > 0.004 ? "text-danger" : "text-success"}`} dir="ltr">
                    {(Number(cash) - Number(settlement.expectedCash ?? 0)).toFixed(2)}
                  </p>
                </div>
              </div>

              {/* stock lines */}
              {lines.length > 0 && (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-border text-xs text-muted">
                        <th className="py-2 text-start font-medium">{t.rep.stockLines}</th>
                        <th className="w-24 py-2 text-end font-medium">{t.rep.expected}</th>
                        <th className="w-28 py-2 text-end font-medium">{t.rep.counted}</th>
                        <th className="w-24 py-2 text-end font-medium">{t.rep.diff}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {lines.map((l) => {
                        const counted = counts[l.productId] ?? l.expectedQty;
                        const diff = Number(counted) - Number(l.expectedQty);
                        return (
                          <tr key={l.productId} className="border-b border-border/60">
                            <td className="tnum py-2 text-muted" dir="ltr">{l.productId.slice(0, 8)}…</td>
                            <td className="tnum py-2 text-end font-semibold" dir="ltr">{Number(l.expectedQty)}</td>
                            <td className="py-2 text-end">
                              <input dir="ltr" inputMode="decimal"
                                className="tnum w-24 rounded-lg border border-input bg-surface py-1 text-end"
                                value={counted}
                                onChange={(e) => setCounts((c) => ({ ...c, [l.productId]: e.target.value.replace(/[^0-9.]/g, "") }))} />
                            </td>
                            <td className={`tnum py-2 text-end font-semibold ${diff !== 0 ? "text-danger" : "text-success"}`} dir="ltr">
                              {diff.toFixed(2)}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}

              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    run(() => {
                      const fd = new FormData();
                      fd.set("settlementId", settlement.id);
                      fd.set("countedCash", cash || "0");
                      fd.set("linesJson", JSON.stringify(lines.map((l) => ({ productId: l.productId, countedQty: counts[l.productId] ?? l.expectedQty }))));
                      return recordCountsAction(fd);
                    }, "✓")
                  }
                  className="btn btn-ghost border border-border"
                >
                  {t.rep.recordCounts}
                </button>
              </div>

              {/* exceptions */}
              {exceptionState.length > 0 && (
                <div className="space-y-2">
                  <h3 className="text-sm font-semibold">{t.rep.exceptions}</h3>
                  {exceptionState.map((e) => (
                    <div key={e.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border p-3 text-sm">
                      <div>
                        <span className={`rounded-lg px-2 py-0.5 text-[11px] font-semibold ${kindTone(e.kind)}`}>
                          {kindLabel(e.kind)} · {entityLabel(e.entity)}
                        </span>
                        {e.diff && <span className="tnum ms-2 font-bold" dir="ltr">{Number(e.diff).toFixed(2)}</span>}
                        {e.note && <p className="mt-1 text-xs text-muted">{e.note}</p>}
                      </div>
                      {e.resolution === "pending" ? (
                        canApproveException && (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={async () => {
                              const ok = await run(() => {
                                const fd = new FormData();
                                fd.set("exceptionId", e.id);
                                return approveExceptionAction(fd);
                              }, "✓");
                              if (ok) {
                                setExceptionState((prev) => prev.map((x) => (x.id === e.id ? { ...x, resolution: "approved_adjustment" } : x)));
                              }
                            }}
                            className="btn btn-ghost !px-3 !py-1.5 text-xs text-primary"
                          >
                            <ShieldCheck className="h-3.5 w-3.5" /> {t.rep.approveException}
                          </button>
                        )
                      ) : (
                        <span className="rounded-lg bg-success-soft px-2 py-1 text-[11px] font-semibold text-success">
                          <CheckCircle2 className="inline h-3.5 w-3.5" />
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {pendingExceptions.length > 0 && (
                <p className="flex items-start gap-2 rounded-xl bg-warning-soft px-4 py-2.5 text-xs text-warning">
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /> {t.rep.pendingExceptions}
                </p>
              )}

              {canFinalize && (
                <button
                  type="button"
                  disabled={busy || pendingExceptions.length > 0}
                  onClick={() => {
                    if (!window.confirm(t.rep.closeConfirm)) return;
                    void run(() => {
                      const fd = new FormData();
                      fd.set("settlementId", settlement.id);
                      return closeSettlementAction(fd);
                    }, t.rep.closeDone).then((ok) => { if (ok) setStatus("closed"); });
                  }}
                  className="btn btn-primary disabled:opacity-40"
                >
                  <Lock className="h-4 w-4" /> {t.rep.close}
                </button>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}
