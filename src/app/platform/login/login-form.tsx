"use client";

import { useEffect } from "react";
import { useActionState } from "react";
import { useRouter } from "next/navigation";
import { platformLoginAction, type PlatformFormState } from "@/modules/platform/actions";
import { Field, Message, SubmitButton, usePlatformLocale } from "../ui";

const initial: PlatformFormState = { ok: false };

export function LoginForm() {
  const [state, action] = useActionState(platformLoginAction, initial);
  const { t, errors } = usePlatformLocale();
  const router = useRouter();

  /**
   * The console requires TOTP. When the operator's password is right but the account is not
   * enrolled yet, the action returns `redirectTo: "/platform/login/enroll"` — a first-run path
   * this form must actually follow. Ignoring that field (the previous behaviour) meant a fresh
   * installation showed an error message and never reached the enrollment screen, so the console
   * could not be entered at all.
   */
  useEffect(() => {
    if (state?.redirectTo) router.replace(state.redirectTo);
  }, [state?.redirectTo, router]);

  return (
    <form action={action} className="mt-5 space-y-3">
      <Field label={t.email}>
        <input className="input" name="email" type="email" autoComplete="username" required dir="ltr" />
      </Field>
      <Field label={t.password}>
        <input className="input" name="password" type="password" autoComplete="current-password" required />
      </Field>
      <Field label={t.totp} hint={t.totpHint}>
        <input className="input tnum" name="totp" inputMode="numeric" dir="ltr" placeholder="000000" />
      </Field>
      <SubmitButton>{t.login}</SubmitButton>
      {state.errorKey ? <Message tone="danger" text={errors[state.errorKey] ?? state.errorKey} /> : null}
      {state.redirectTo ? (
        <p className="text-xs text-muted" role="status">
          {/* a link as well as the redirect: keyboard users and no-JS clients still get there */}
          <a className="underline" href={state.redirectTo}>
            {errors.platformTotpEnrollRequired ?? t.totpHint}
          </a>
        </p>
      ) : null}
    </form>
  );
}
