"use client";

import { useState } from "react";
import type { ActionResult } from "@/modules/shared/action-result";

interface ActionButtonProps {
  label: string;
  action: (fd: FormData) => Promise<ActionResult>;
  fields: Record<string, string>;
  confirmText?: string;
  variant?: "primary" | "ghost" | "danger";
  okText?: string;
  errors: Record<string, string>;
  className?: string;
}

/** One-click server-action button with confirm, pending state, and inline result. */
export function ActionButton({
  label,
  action,
  fields,
  confirmText,
  variant = "primary",
  okText,
  errors,
  className,
}: ActionButtonProps) {
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  async function run() {
    if (confirmText && !window.confirm(confirmText)) return;
    setPending(true);
    setResult(null);
    try {
      const fd = new FormData();
      for (const [k, v] of Object.entries(fields)) fd.set(k, v);
      const res = await action(fd);
      if (res.ok) {
        setResult({ ok: true, text: okText ?? "✓" });
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

  const base =
    variant === "danger"
      ? "text-danger hover:bg-danger-soft"
      : variant === "ghost"
        ? "btn-ghost"
        : "btn-primary";

  return (
    <span className="inline-flex items-center gap-2">
      <button type="button" onClick={run} disabled={pending} className={`btn ${base} !px-3 !py-1.5 text-xs disabled:opacity-50 ${className ?? ""}`}>
        {pending ? "…" : label}
      </button>
      {result && (
        <span className={`text-xs font-medium ${result.ok ? "text-success" : "text-danger"}`} role="status">
          {result.text}
        </span>
      )}
    </span>
  );
}
