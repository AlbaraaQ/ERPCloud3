"use client";

import { useState } from "react";
import {
  saveTaxConfigAction,
  generateDeviceKeyAction,
  saveCredentialAction,
  retrySubmissionAction,
} from "@/modules/tax/actions";
import { ActionButton } from "@/components/forms/action-button";
import type { Dict } from "@/i18n";
import type { taxConfigs, companies } from "@/db/schema";
import { AlertCircle, CheckCircle2, KeyRound } from "lucide-react";

function ResultBox({ result }: { result: { ok: boolean; text: string } | null }) {
  if (!result) return null;
  return (
    <div role="status" className={`mt-3 flex items-start gap-2 rounded-xl px-4 py-2.5 text-sm ${result.ok ? "bg-success-soft" : "bg-danger-soft"}`}>
      {result.ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 text-success" /> : <AlertCircle className="mt-0.5 h-4 w-4 text-danger" />}
      <span>{result.text}</span>
    </div>
  );
}

function errText(errors: Record<string, string>, key?: string) {
  return errors[key?.split(".")[1] ?? "unexpected"] ?? errors.unexpected;
}

type Cfg = typeof taxConfigs.$inferSelect | null;
type Company = typeof companies.$inferSelect | null;

export function TaxConfigForm({
  t, errors, cfg, company, canConfigure,
}: { t: Dict; errors: Record<string, string>; cfg: Cfg; company: Company; canConfigure: boolean }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  const missing: string[] = [];
  if (!company?.legalName) missing.push("اسم نظامي");
  if (!/^\d{15}$/.test(company?.vatNumber ?? "")) missing.push("رقم ضريبي (15)");
  if (cfg?.enabled && !cfg.city) missing.push("مدينة");
  if (cfg?.enabled && !cfg.postalCode) missing.push("رمز بريدي");

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    setBusy(true);
    setResult(null);
    try {
      const res = await saveTaxConfigAction(fd);
      setResult(res.ok ? { ok: true, text: t.taxPg.configSaved } : { ok: false, text: errText(errors, res.errorKey) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="card space-y-4 p-5">
      <h3 className="font-semibold">{t.taxPg.config}</h3>

      {missing.length > 0 && (
        <div className="rounded-xl bg-warning-soft px-4 py-2.5 text-xs leading-relaxed text-warning">
          {errors.taxConfigIncomplete} — {missing.join("، ")}
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex items-center gap-2 rounded-xl border border-border p-3 text-sm">
          <input type="checkbox" name="enabled" value="true" defaultChecked={cfg?.enabled ?? false} className="h-4 w-4 accent-[var(--primary)]" />
          {t.taxPg.enabled}
        </label>
        <label className="block text-sm">
          <span className="mb-1 block font-medium">{t.taxPg.env}</span>
          <select name="env" className="input" defaultValue={cfg?.env ?? "developer-portal"} disabled={!canConfigure}>
            <option value="developer-portal">{t.taxPg.envDev}</option>
            <option value="simulation">{t.taxPg.envSim}</option>
            <option value="core">{t.taxPg.envCore}</option>
          </select>
        </label>
        <label className="block text-sm">
          <span className="mb-1 block font-medium">{t.taxPg.street}</span>
          <input name="street" className="input" defaultValue={cfg?.street ?? ""} disabled={!canConfigure} />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block font-medium">{t.taxPg.district}</span>
          <input name="district" className="input" defaultValue={cfg?.district ?? ""} disabled={!canConfigure} />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block font-medium">{t.taxPg.city}</span>
          <input name="city" className="input" defaultValue={cfg?.city ?? ""} disabled={!canConfigure} />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block font-medium">{t.taxPg.postalCode}</span>
          <input name="postalCode" dir="ltr" className="input" defaultValue={cfg?.postalCode ?? ""} disabled={!canConfigure} />
        </label>
        <label className="block text-sm sm:col-span-2">
          <span className="mb-1 block font-medium">{t.taxPg.industry}</span>
          <input name="industry" className="input" defaultValue={cfg?.industry ?? ""} disabled={!canConfigure} />
        </label>
        <label className="flex items-center gap-2 rounded-xl border border-border p-3 text-xs sm:col-span-2">
          <input type="checkbox" name="freeGoodsDeemedSupply" value="true" defaultChecked={cfg?.freeGoodsDeemedSupply ?? false} className="h-4 w-4 accent-[var(--primary)]" disabled={!canConfigure} />
          {t.taxPg.freeGoodsPolicy}
        </label>
      </div>

      <p className="text-xs text-muted">{t.taxPg.vatNote}</p>

      {canConfigure && (
        <button type="submit" disabled={busy} className="btn btn-primary">{busy ? t.common.loading : t.taxPg.saveConfig}</button>
      )}
      <ResultBox result={result} />
    </form>
  );
}

export function CredentialsPanel({
  t, errors, canConfigure, certs,
}: { t: Dict; errors: Record<string, string>; canConfigure: boolean; certs: { env: string; kind: string; status: string; label: string | null }[] }) {
  const [kind, setKind] = useState("production");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  const activeFor = (k: string) => certs.filter((c) => c.kind === k && c.status === "active");

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    setBusy(true);
    setResult(null);
    try {
      const res = await saveCredentialAction(fd);
      setResult(res.ok ? { ok: true, text: t.taxPg.credsSaved } : { ok: false, text: errText(errors, res.errorKey) });
      if (res.ok) (e.target as HTMLFormElement).reset();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <section className="card space-y-3 p-5">
        <h3 className="font-semibold">{t.taxPg.onboarding}</h3>
        <p className="text-xs leading-relaxed text-muted">{t.taxPg.onboardingSteps}</p>
        <div className="flex flex-wrap gap-2 text-[11px]">
          {["device_key: " + (activeFor("device_key").length > 0 ? "✓" : "—"),
            "compliance: " + (activeFor("compliance").length > 0 ? "✓" : "—"),
            "production: " + (activeFor("production").length > 0 ? "✓" : "—")].map((s) => (
            <span key={s} className={`rounded-lg px-2 py-1 font-semibold ${s.endsWith("✓") ? "bg-success-soft text-success" : "bg-surface-3 text-muted"}`}>{s}</span>
          ))}
        </div>
        {canConfigure && (
          <ActionButton
            label={t.taxPg.genDeviceKey}
            action={generateDeviceKeyAction}
            fields={{}}
            okText={t.taxPg.deviceKeyDone}
            errors={errors}
          />
        )}
      </section>

      {canConfigure && (
        <form onSubmit={onSubmit} className="card space-y-3 p-5">
          <h3 className="flex items-center gap-2 font-semibold"><KeyRound className="h-4 w-4 text-primary" /> {t.taxPg.credentials}</h3>
          <input type="hidden" name="kind" value={kind} />
          <div className="grid grid-cols-2 gap-2 text-xs font-semibold">
            <button type="button" onClick={() => setKind("compliance")}
              className={`rounded-xl py-2 ${kind === "compliance" ? "bg-primary text-primary-foreground" : "bg-surface-2 text-muted"}`}>
              {t.taxPg.compliance}
            </button>
            <button type="button" onClick={() => setKind("production")}
              className={`rounded-xl py-2 ${kind === "production" ? "bg-primary text-primary-foreground" : "bg-surface-2 text-muted"}`}>
              {t.taxPg.production}
            </button>
          </div>
          <label className="block text-sm">
            <span className="mb-1 block font-medium">{t.taxPg.token}</span>
            <input name="binarySecurityToken" required dir="ltr" className="input" autoComplete="off" />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block font-medium">{t.taxPg.secret}</span>
            <input name="secret" required dir="ltr" type="password" className="input" autoComplete="new-password" />
          </label>
          <p className="flex items-start gap-1.5 text-[11px] text-muted">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" /> {t.taxPg.credWarn}
          </p>
          <button type="submit" disabled={busy} className="btn btn-primary">{busy ? t.common.loading : t.taxPg.saveCreds}</button>
          <ResultBox result={result} />
        </form>
      )}
    </div>
  );
}

export function RetryButtons({ t, errors, submissionId }: { t: Dict; errors: Record<string, string>; submissionId: string }) {
  return (
    <ActionButton
      label={t.taxPg.retry}
      action={retrySubmissionAction}
      fields={{ submissionId }}
      variant="ghost"
      okText={t.taxPg.retryDone}
      errors={errors}
    />
  );
}
