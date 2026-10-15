"use client";

import { useActionState } from "react";
import { platformEnrollmentAction, type PlatformFormState } from "@/modules/platform/actions";
import { Field, Message, SubmitButton, usePlatformLocale } from "../../ui";

const initial: PlatformFormState = { ok: false };

/**
 * Two-step enrolment. Generating the secret is an explicit action so the value
 * shown is the very value signed into the pending cookie — what the screen
 * shows is what the code is verified against.
 */
export function EnrollForm() {
  const [state, action] = useActionState(platformEnrollmentAction, initial);
  const { t, errors } = usePlatformLocale();
  const secret = state.data?.secret as string | undefined;
  const uri = state.data?.uri as string | undefined;

  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="step" value={secret ? "confirm" : "start"} />
      {!secret ? (
        <>
          <ol className="list-decimal space-y-1 ps-5 text-xs text-muted">
            <li>{t.enrollStep1}</li>
            <li>{t.enrollStep2}</li>
          </ol>
          <SubmitButton>{t.enrollStart}</SubmitButton>
        </>
      ) : (
        <>
          <div className="rounded-xl border border-border bg-surface-2/50 p-3">
            <p className="text-xs font-semibold text-muted">{t.enrollSecret}</p>
            <p className="mt-1 break-all font-mono text-sm tracking-widest" dir="ltr">
              {secret}
            </p>
            <p className="mt-2 text-[11px] text-muted">
              {t.enrollUri}: <span className="break-all font-mono" dir="ltr">{uri}</span>
            </p>
          </div>
          <Field label={t.totp}>
            <input className="input tnum" name="code" inputMode="numeric" dir="ltr" required placeholder="000000" />
          </Field>
          <SubmitButton>{t.enrollConfirm}</SubmitButton>
        </>
      )}
      {state.errorKey ? (
        <Message tone="danger" text={errors[state.errorKey] ?? state.errorKey} />
      ) : null}
    </form>
  );
}
