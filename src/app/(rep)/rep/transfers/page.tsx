"use client";

import { useEffect, useState } from "react";
import { kvGet } from "@/pwa/sync-db";
import { enqueueOp } from "@/pwa/sync-engine";
import { getDict } from "@/i18n/dicts";
import { todayBusinessDate } from "@/modules/shared/dates";
import { Truck, CheckCircle2 } from "lucide-react";

const t = getDict("ar");

interface TransferRow {
  id: string;
  transferNo: number | null;
  status: string;
  businessDate: string;
}
interface TransferLineRow {
  transfer_id: string;
  line_id: string;
  name_ar: string;
  sku: string;
  qty_dispatched: string;
  qty_received: string;
  discrepancy_reason: string | null;
}

export default function RepTransfers() {
  const [rows, setRows] = useState<TransferRow[]>([]);
  const [lines, setLines] = useState<TransferLineRow[]>([]);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const cached = await kvGet<{ rows: TransferRow[]; lines: TransferLineRow[] }>("lastTransfers");
      setRows(cached?.rows ?? []);
      setLines(cached?.lines ?? []);
    })();
  }, []);

  async function acceptAll(tr: TransferRow) {
    const accepts = lines
      .filter((l) => l.transfer_id === tr.id)
      .map((l) => ({
        lineId: l.line_id,
        qty: (Number(l.qty_dispatched) - Number(l.qty_received)).toString(),
      }))
      .filter((a) => Number(a.qty) > 0);
    if (accepts.length === 0) return;
    const opId = await enqueueOp(
      "transfer.accept",
      { transferId: tr.id, accepts, businessDate: todayBusinessDate() },
      `استلام تحويل #${tr.transferNo ?? ""}`,
    );
    setDone(opId);
    setTimeout(() => setDone(null), 5000);
    setRows((prev) => prev.filter((r) => r.id !== tr.id));
  }

  const incoming = rows.filter((r) => r.status === "dispatched" || r.status === "partially_received");

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold">{t.rep.transfersTitle}</h1>
      {done && (
        <div className="flex items-center gap-2 rounded-xl bg-success-soft px-4 py-2.5 text-sm">
          <CheckCircle2 className="h-4 w-4 text-success" /> {t.rep.accepted}
        </div>
      )}
      {incoming.length === 0 ? (
        <div className="card p-8 text-center text-sm text-muted">
          <Truck className="mx-auto mb-3 h-10 w-10 opacity-40" /> {t.rep.noTransfers}
        </div>
      ) : (
        incoming.map((tr) => {
          const trLines = lines.filter((l) => l.transfer_id === tr.id);
          return (
            <section key={tr.id} className="card p-4">
              <div className="mb-3 flex items-center justify-between">
                <div>
                  <p className="font-bold">#{tr.transferNo ?? "—"}</p>
                  <p className="tnum text-xs text-muted" dir="ltr">{tr.businessDate}</p>
                </div>
                <button type="button" onClick={() => acceptAll(tr)} className="btn btn-primary !py-2 text-xs">
                  {t.rep.acceptAll}
                </button>
              </div>
              <ul className="space-y-1.5">
                {trLines.map((l) => (
                  <li key={l.line_id} className="flex items-center justify-between rounded-lg bg-surface-2 px-3 py-2 text-sm">
                    <span className="min-w-0 truncate">{l.name_ar}</span>
                    <span className="tnum shrink-0 font-semibold" dir="ltr">
                      {Number(l.qty_dispatched) - Number(l.qty_received)} / {l.qty_dispatched}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          );
        })
      )}
    </div>
  );
}
