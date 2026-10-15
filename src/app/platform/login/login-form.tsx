"use client";

import { useActionState } from "react";
import { platformLoginAction, type PlatformFormState } from "@/modules/platform/actions";
import { Field, Message, SubmitButton, usePlatformLocale } from "../ui";

const initial: PlatformFormState = { ok: false };

export function LoginForm() {
  const [state, action] = useActionState(platformLoginAction, initial);
  const { t, errors } = usePlatformLocale();

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
    </form>
  );
}
