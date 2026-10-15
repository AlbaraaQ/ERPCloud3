"use client";

import { useEffect, useState, useCallback } from "react";
import { repDb, kvGet, type OutboxRow } from "@/pwa/sync-db";
import { getDeviceId } from "@/pwa/sync-engine";
import { getDict } from "@/i18n/dicts";
import {
  CloudUpload, Clock, RefreshCw, CloudCheck, XCircle, AlertTriangle, ShieldX,
} from "lucide-react";

const t = getDict("ar");

const STATE_META: Record<string, { label: () => string; icon: typeof Clock; tone: string }> = {
  pending: { label: () => t.rep.statePending, icon: Clock, tone: "bg-warning-soft text-warning" },
  syncing: { label: () => t.rep.stateSyncing, icon: RefreshCw, tone: "bg-info-soft text-info" },
  synced: { label: () => t.rep.stateSynced, icon: CloudCheck, tone: "bg-success-soft text-success" },
  rejected: { label: () => t.rep.stateRejected, icon: XCircle, tone: "bg-danger-soft text-danger" },
  conflict: { label: () => t.rep.stateConflict, icon: AlertTriangle, tone: "bg-danger-soft text-danger" },
  tamper: { label: () => t.rep.stateTamper, icon: ShieldX, tone: "bg-danger-soft text-danger" },
};

export default function RepSync() {
  const [rows, setRows] = useState<OutboxRow[]>([]);
  const [deviceId, setDeviceId] = useState("");
  const [lastPull, setLastPull] = useState<string | null>(null);
  const [lastSync, setLastSync] = useState<string | null>(null);

  const load = useCallback(async () => {
    const all = await repDb().outbox.orderBy("createdAt").reverse().limit(100).toArray();
    setRows(all);
    setDeviceId((await getDeviceId()).slice(0, 13));
    setLastPull(await kvGet<string>("lastPullAt"));
    setLastSync(await kvGet<string>("lastSyncAt"));
  }, []);

  useEffect(() => {
    const kick = setTimeout(() => void load(), 0);
    const i = setInterval(load, 3000);
    return () => {
      clearTimeout(kick);
      clearInterval(i);
    };
  }, [load]);

  const err = (k?: string) => (k ? ((getDict("ar").errors as Record<string, string>)[k.split(".")[1] ?? ""] ?? k) : null);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold">{t.rep.syncTitle}</h1>
        <CloudUpload className="h-5 w-5 text-primary" />
      </div>

      <section className="card space-y-1 p-4 text-xs text-muted">
        <p>{t.rep.device}: <span className="tnum font-semibold text-foreground" dir="ltr">{deviceId}</span></p>
        <p>{t.rep.lastPull}: <span className="tnum text-foreground" dir="ltr">{lastPull ? new Date(lastPull).toLocaleTimeString("en-GB") : "—"}</span></p>
        <p>{t.rep.lastSync}: <span className="tnum text-foreground" dir="ltr">{lastSync ? new Date(lastSync).toLocaleTimeString("en-GB") : "—"}</span></p>
      </section>

      {rows.length === 0 ? (
        <div className="card p-8 text-center text-sm text-muted">{t.rep.emptyOutbox}</div>
      ) : (
        <div className="space-y-2">
          {rows.map((r) => {
            const meta = STATE_META[r.state] ?? STATE_META.pending;
            const Icon = meta.icon;
            return (
              <div key={r.opId} className="card flex items-center gap-3 p-3">
                <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-xl ${meta.tone}`}>
                  <Icon className={`h-4 w-4 ${r.state === "syncing" ? "animate-spin" : ""}`} />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold">{r.title}</p>
                  <p className="text-[11px] text-muted">
                    {meta.label()}
                    {r.lastError ? ` — ${err(r.lastError) ?? r.lastError}` : ""}
                  </p>
                  <p className="tnum text-[10px] text-muted" dir="ltr">
                    {new Date(r.createdAt).toLocaleTimeString("en-GB")} · {r.opType}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
