"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { loginAction, type AuthFormState } from "@/modules/identity/actions";
import type { Dict } from "@/i18n";
import { Mail, Lock, AlertCircle, LogIn } from "lucide-react";

const initialState: AuthFormState = {};

function errorText(t: Dict, key?: string): string | null {
  if (!key) return null;
  const path = key.split(".");
  // login errors live under errors.*
  const dict = t as unknown as Record<string, Record<string, string>>;
  return dict[path[0]]?.[path[1]] ?? t.errors.unexpected;
}

function SubmitButton({ t }: { t: Dict }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn btn-primary w-full" disabled={pending}>
      {pending ? t.login.submitting : t.login.submit}
      <LogIn className="h-4 w-4 rtl:-scale-x-100" aria-hidden />
    </button>
  );
}

export function LoginForm({ t }: { t: Dict }) {
  const [state, formAction] = useActionState(loginAction, initialState);
  const message = errorText(t, state?.errorKey);

  return (
    <form action={formAction} className="mt-6 space-y-4">
      {message && (
        <div
          role="alert"
          className="flex items-start gap-2.5 rounded-xl border border-danger/30 bg-danger-soft px-4 py-3 text-sm text-foreground"
        >
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-danger" aria-hidden />
          <span>{message}</span>
        </div>
      )}

      <div className="space-y-1.5">
        <label htmlFor="email" className="text-sm font-medium">
          {t.login.email}
        </label>
        <div className="relative">
          <Mail className="pointer-events-none absolute end-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" aria-hidden />
          <input
            id="email"
            name="email"
            type="email"
            dir="ltr"
            autoComplete="email"
            required
            className="input pe-9 text-start"
            placeholder="name@company.com"
          />
        </div>
      </div>

      <div className="space-y-1.5">
        <label htmlFor="password" className="text-sm font-medium">
          {t.login.password}
        </label>
        <div className="relative">
          <Lock className="pointer-events-none absolute end-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" aria-hidden />
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            className="input pe-9"
            placeholder="••••••••"
          />
        </div>
      </div>

      <SubmitButton t={t} />
    </form>
  );
}
