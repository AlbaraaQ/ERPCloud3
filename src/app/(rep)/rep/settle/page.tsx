"use client";

import { useState } from "react";
import { enqueueOp } from "@/pwa/sync-engine";
import { todayBusinessDate } from "@/modules/shared/dates";
import { getDict } from "@/i18n/dicts";
import { Scale, CheckCircle2 } from "lucide-react";

const t = getDict("ar");

export default function RepSettle() {
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  async function request() {
    setBusy(true);
    await enqueueOp("settlement.request", { businessDate: todayBusinessDate() }, "طلب تسوية اليوم");
    setDone(true);
    setBusy(false);
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Scale className="h-6 w-6 text-primary" />
        <h1 className="text-xl font-bold">{t.rep.settleTitle}</h1>
      </div>

      <div className="card space-y-3 p-5">
        <p className="text-sm leading-relaxed text-muted">{t.rep.settleHint}</p>
        {done ? (
          <div className="flex items-center gap-2 rounded-xl bg-success-soft px-4 py-3 text-sm">
            <CheckCircle2 className="h-4 w-4 text-success" /> {t.rep.settleRequested}
          </div>
        ) : (
          <button type="button" onClick={request} disabled={busy} className="btn btn-primary w-full !py-3.5 text-base disabled:opacity-50">
            {t.rep.settleRequest}
          </button>
        )}
      </div>
    </div>
  );
}
