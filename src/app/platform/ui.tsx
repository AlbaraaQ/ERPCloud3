"use client";

/**
 * Small console primitives. Client components read labels from `@/i18n/dicts`
 * (the server module pulls `next/headers`), exactly like the tenant UI.
 */

import { useActionState, type ReactNode } from "react";
import { useFormStatus } from "react-dom";
import { getDict, LOCALE_COOKIE, DEFAULT_LOCALE, type Locale } from "@/i18n/dicts";
import type { PlatformFormState } from "@/modules/platform/actions";

export function usePlatformLocale() {
  // client-side locale read (cookie is not httpOnly)
  const value =
    typeof document === "undefined"
      ? null
      : new RegExp(`${LOCALE_COOKIE}=([^;]+)`).exec(document.cookie)?.[1];
  const locale: Locale = value === "en" ? "en" : DEFAULT_LOCALE;
  const dict = getDict(locale);
  return { t: dict.platform, errors: dict.errors as Record<string, string>, locale };
}

export function PlatformCard({
  title,
  children,
  tone = "default",
}: {
  title?: ReactNode;
  children: ReactNode;
  tone?: "default" | "danger" | "warning";
}) {
  const border =
    tone === "danger" ? "border-danger/40" : tone === "warning" ? "border-warning/40" : "border-border";
  return (
    <section className={`card ${border} p-4`}>
      {title ? <h2 className="mb-3 text-sm font-bold">{title}</h2> : null}
      {children}
    </section>
  );
}

export function Row({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-end gap-3">{children}</div>;
}

export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: ReactNode;
}) {
  return (
    <label className="block min-w-[10rem] flex-1">
      <span className="mb-1 block text-xs font-semibold text-muted">{label}</span>
      {children}
      {hint ? <span className="mt-1 block text-[11px] text-muted">{hint}</span> : null}
    </label>
  );
}

export function SubmitButton({
  children,
  variant = "primary",
  confirm,
  disabled,
}: {
  children: ReactNode;
  variant?: "primary" | "ghost" | "danger";
  confirm?: string;
  disabled?: boolean;
}) {
  const { pending } = useFormStatus();
  const cls =
    variant === "primary" ? "btn btn-primary" : variant === "danger" ? "btn bg-danger text-white" : "btn btn-ghost";
  return (
    <button
      type="submit"
      className={cls}
      disabled={pending || disabled}
      onClick={(e) => {
        if (confirm && !window.confirm(confirm)) e.preventDefault();
      }}
    >
      {pending ? "…" : children}
    </button>
  );
}

/** `useActionState` wrapper so every console form reports success or an error key. */
export function ActionForm({
  action,
  children,
  className,
  hidden,
  confirm,
  render,
  submitLabel,
}: {
  action: (state: PlatformFormState, formData: FormData) => Promise<PlatformFormState>;
  children?: ReactNode;
  className?: string;
  hidden?: Record<string, string>;
  confirm?: string;
  render?: (state: PlatformFormState) => ReactNode;
  submitLabel?: ReactNode;
}) {
  const [state, formAction] = useActionState(action, { ok: false } as PlatformFormState);
  const { t, errors } = usePlatformLocale();
  return (
    <form action={formAction} className={className}>
      {hidden
        ? Object.entries(hidden).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)
        : null}
      {children}
      {submitLabel ? <div className="mt-3">{<SubmitButton confirm={confirm}>{submitLabel}</SubmitButton>}</div> : null}
      {state.errorKey ? <Message tone="danger" text={errors[state.errorKey] ?? state.errorKey} /> : null}
      {state.ok && state.okKey ? (
        <Message
          tone="success"
          text={(t as unknown as Record<string, string>)[state.okKey.split(".")[1] ?? ""] ?? t.saved}
        />
      ) : null}
      {render?.(state)}
    </form>
  );
}

export function Message({ tone, text }: { tone: "danger" | "success" | "warning"; text: ReactNode }) {
  const cls =
    tone === "danger"
      ? "border-danger/40 bg-danger-soft text-danger"
      : tone === "warning"
        ? "border-warning/40 bg-warning-soft text-warning"
        : "border-success/40 bg-success-soft text-success";
  return <p className={`mt-3 rounded-xl border px-3 py-2 text-xs font-semibold ${cls}`}>{text}</p>;
}

export function Badge({
  children,
  tone = "muted",
}: {
  children: ReactNode;
  tone?: "muted" | "success" | "warning" | "danger" | "info";
}) {
  const cls =
    tone === "success"
      ? "bg-success-soft text-success"
      : tone === "warning"
        ? "bg-warning-soft text-warning"
        : tone === "danger"
          ? "bg-danger-soft text-danger"
          : tone === "info"
            ? "bg-surface-2 text-foreground"
            : "bg-surface-2 text-muted";
  return <span className={`inline-block rounded-md px-2 py-0.5 text-[11px] font-bold ${cls}`}>{children}</span>;
}

/** Plain (non-state) action button used by one-click mutations. */
export function SimpleAction({
  action,
  label,
  variant = "ghost",
  confirm,
  hidden,
}: {
  action: (formData: FormData) => Promise<unknown>;
  label: ReactNode;
  variant?: "primary" | "ghost" | "danger";
  confirm?: string;
  hidden?: Record<string, string>;
}) {
  return (
    <form action={action as (formData: FormData) => void}>
      {hidden
        ? Object.entries(hidden).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)
        : null}
      <SubmitButton variant={variant} confirm={confirm}>
        {label}
      </SubmitButton>
    </form>
  );
}

export function StatCard({
  label,
  value,
  hint,
  tone = "default",
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: "default" | "success" | "warning" | "danger";
}) {
  const valueTone =
    tone === "danger" ? "text-danger" : tone === "warning" ? "text-warning" : tone === "success" ? "text-success" : "";
  return (
    <div className="card p-4">
      <p className="text-xs font-semibold text-muted">{label}</p>
      <p className={`mt-1 text-2xl font-bold tnum ${valueTone}`}>{value}</p>
      {hint ? <p className="mt-1 text-[11px] text-muted">{hint}</p> : null}
    </div>
  );
}

export function Table({ head, children }: { head: ReactNode[]; children: ReactNode }) {
  return (
    <div className="card overflow-x-auto">
      <table className="w-full min-w-[42rem] text-sm">
        <thead className="bg-surface-2/60 text-xs text-muted">
          <tr>
            {head.map((h, i) => (
              <th key={i} className="whitespace-nowrap px-3 py-2 text-start font-semibold">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

export function fmtBytes(n: number | null | undefined): string {
  if (!n) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}

export function fmtDate(d: Date | string | null | undefined): string {
  if (!d) return "—";
  const date = typeof d === "string" ? new Date(d) : d;
  return new Intl.DateTimeFormat("en-GB", { dateStyle: "short", timeStyle: "short" }).format(date);
}

export function statusTone(status: string): "muted" | "success" | "warning" | "danger" | "info" {
  switch (status) {
    case "active":
    case "verified":
    case "uploaded":
    case "passed":
    case "ready":
    case "purged":
      return "success";
    case "trial":
    case "local_ok":
    case "running":
    case "cooling_off":
    case "requested":
    case "queued":
      return "info";
    case "suspended":
    case "failed":
    case "expired":
    case "warning":
      return "warning";
    case "deactivated":
    case "pruned":
    case "critical":
      return "danger";
    default:
      return "muted";
  }
}
