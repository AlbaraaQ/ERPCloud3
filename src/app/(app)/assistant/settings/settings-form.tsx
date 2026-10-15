"use client";

/**
 * Assistant settings form (AI_ASSISTANT §1, §5).
 *
 * The key is entered as the NAME of an environment variable, never as a secret:
 * the row stores `secretRef` and the server reads `process.env[secretRef]`. That is
 * why this form can be plain HTML — a mistyped key cannot leak into the database,
 * and the field is validated server-side as an identifier.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { saveAiSettingsAction } from "@/modules/ai/actions";

interface Props {
  t: {
    settingsTitle: string;
    settingsSubtitle: string;
    enabledLabel: string;
    provider: string;
    model: string;
    baseUrl: string;
    secretRef: string;
    secretRefHint: string;
    dataScope: string;
    dataScopeMetrics: string;
    dataScopeNames: string;
    retentionDays: string;
    save: string;
    settingsSaved: string;
  };
  errors: Record<string, string>;
  config: {
    enabled: boolean;
    provider: string;
    model: string;
    baseUrl: string | null;
    secretRef: string | null;
    dataScope: string;
    retentionDays: number;
  };
  /** providers this build can talk to; the server validates the value again */
  providers: readonly string[];
}

export function AssistantSettingsForm({ t, errors, config, providers }: Props) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);

  async function onSubmit(formData: FormData) {
    setPending(true);
    setNotice(null);
    try {
      const res = await saveAiSettingsAction(formData);
      if (res.ok) {
        setNotice({ ok: true, text: t.settingsSaved });
        router.refresh();
      } else {
        const leaf = res.errorKey?.split(".")[1] ?? "unexpected";
        setNotice({ ok: false, text: errors[leaf] ?? errors.unexpected ?? "" });
      }
    } catch {
      setNotice({ ok: false, text: errors.unexpected ?? "" });
    } finally {
      setPending(false);
    }
  }

  return (
    <form action={onSubmit} className="card space-y-4 p-4">
      <div>
        <h1 className="text-lg font-bold">{t.settingsTitle}</h1>
        <p className="mt-1 text-sm text-muted">{t.settingsSubtitle}</p>
      </div>

      <label className="flex items-center gap-2 text-sm font-medium">
        <input type="checkbox" name="enabled" defaultChecked={config.enabled} className="h-4 w-4" />
        {t.enabledLabel}
      </label>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1 block text-xs font-semibold text-muted">{t.provider}</span>
          <select name="provider" defaultValue={config.provider} className="input">
            {providers.map((provider) => (
              <option key={provider} value={provider}>
                {provider}
              </option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="mb-1 block text-xs font-semibold text-muted">{t.model}</span>
          <input name="model" defaultValue={config.model} className="input" dir="ltr" autoComplete="off" />
        </label>

        <label className="block">
          <span className="mb-1 block text-xs font-semibold text-muted">{t.baseUrl}</span>
          <input name="baseUrl" defaultValue={config.baseUrl ?? ""} className="input" dir="ltr" autoComplete="off" />
        </label>

        <label className="block">
          <span className="mb-1 block text-xs font-semibold text-muted">{t.secretRef}</span>
          <input name="secretRef" defaultValue={config.secretRef ?? ""} className="input" dir="ltr" autoComplete="off" />
          <span className="mt-1 block text-[11px] text-muted">{t.secretRefHint}</span>
        </label>

        <label className="block">
          <span className="mb-1 block text-xs font-semibold text-muted">{t.dataScope}</span>
          <select name="dataScope" defaultValue={config.dataScope} className="input">
            <option value="metrics_only">{t.dataScopeMetrics}</option>
            <option value="names_allowed">{t.dataScopeNames}</option>
          </select>
        </label>

        <label className="block">
          <span className="mb-1 block text-xs font-semibold text-muted">{t.retentionDays}</span>
          <input
            name="retentionDays"
            type="number"
            min={1}
            max={365}
            defaultValue={config.retentionDays}
            className="input tnum"
            dir="ltr"
          />
        </label>
      </div>

      {notice ? (
        <p className={`text-sm ${notice.ok ? "text-success" : "text-danger"}`}>{notice.text}</p>
      ) : null}

      <button type="submit" className="btn btn-primary" disabled={pending}>
        {t.save}
      </button>
    </form>
  );
}
