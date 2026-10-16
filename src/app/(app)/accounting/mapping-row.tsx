"use client";

import { useState } from "react";
import { saveMappingAction } from "@/modules/accounting/actions";
import { CheckCircle2, AlertTriangle } from "lucide-react";

interface MappingRowProps {
  mapKey: string;
  nameAr: string;
  accountId: string | null;
  accounts: { id: string; code: string; name: string }[];
  saveLabel: string;
  missingLabel: string;
  savedLabel: string;
}

/** Posting-mapping row: account select + save (blocks posting when unset). */
export function MappingRow({ mapKey, nameAr, accountId, accounts, saveLabel, missingLabel, savedLabel }: MappingRowProps) {
  const [value, setValue] = useState(accountId ?? "");
  const [state, setState] = useState<"idle" | "saving" | "saved">("idle");
  const missing = !value;

  async function save() {
    if (!value) return;
    setState("saving");
    const fd = new FormData();
    fd.set("key", mapKey);
    fd.set("accountId", value);
    const res = await saveMappingAction(fd);
    setState(res.ok ? "saved" : "idle");
    setTimeout(() => setState((s) => (s === "saved" ? "idle" : s)), 2500);
  }

  return (
    <tr className="border-b border-border/60">
      <th scope="row" className="py-2 pe-2 text-start text-sm font-medium">{nameAr}</th>
      <td className="py-2">
        <select aria-label={nameAr} className="input !py-1.5 text-xs" value={value} onChange={(e) => setValue(e.target.value)}>
          <option value="">—</option>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.code} — {a.name}
            </option>
          ))}
        </select>
      </td>
      <td className="py-2 text-start">
        {missing ? (
          <span className="inline-flex items-center gap-1 rounded-lg bg-danger-soft px-2 py-1 text-[11px] font-semibold text-danger">
            <AlertTriangle className="h-3.5 w-3.5" /> {missingLabel}
          </span>
        ) : state === "saved" ? (
          <span className="inline-flex items-center gap-1 rounded-lg bg-success-soft px-2 py-1 text-[11px] font-semibold text-success">
            <CheckCircle2 className="h-3.5 w-3.5" /> {savedLabel}
          </span>
        ) : (
          <button type="button" onClick={save} disabled={state === "saving" || value === accountId}
            className="btn btn-ghost border border-border !px-3 !py-1 text-xs disabled:opacity-40">
            {saveLabel}
          </button>
        )}
      </td>
    </tr>
  );
}
