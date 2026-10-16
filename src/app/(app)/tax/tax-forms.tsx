"use client";

import { useState } from "react";
import {
  saveTaxConfigAction,
  saveCredentialAction,
  retrySubmissionAction,
  startOnboardingAction,
  runComplianceChecksAction,
  issueProductionCsidAction,
  renewProductionCsidAction,
} from "@/modules/tax/actions";
import { ActionButton } from "@/components/forms/action-button";
import type { Dict } from "@/i18n";
import type { taxConfigs, companies } from "@/db/schema";
import { AlertCircle, CheckCircle2, KeyRound, ShieldCheck, XCircle, Clock } from "lucide-react";

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
      <h2 className="font-semibold">{t.taxPg.config}</h2>

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

const CHECK_LABELS: Record<string, keyof Dict["taxPg"]> = {
  standard_invoice: "checkStdInvoice",
  standard_credit_note: "checkStdCredit",
  standard_debit_note: "checkStdDebit",
  simplified_invoice: "checkSimpInvoice",
  simplified_credit_note: "checkSimpCredit",
  simplified_debit_note: "checkSimpDebit",
};

export interface OnboardingView {
  enabled: boolean;
  env: string;
  state: string;
  hasDeviceKey: boolean;
  csr: string | null;
  complianceRequestId: string | null;
  compliance: { expiresAt: string | null } | null;
  production: { expiresAt: string | null; daysLeft: number | null } | null;
  checks: { kind: string; status: string; validationStatus: string | null; attempts: number }[];
  canIssueProduction: boolean;
}

export function OnboardingPanel({
  t, errors, canConfigure, status, certs,
}: {
  t: Dict;
  errors: Record<string, string>;
  canConfigure: boolean;
  status: OnboardingView;
  certs: { env: string; kind: string; status: string; label: string | null }[];
}) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  const stepState = (done: boolean) => (done ? "bg-success-soft text-success" : "bg-surface-3 text-muted");
  const checkOf = (kind: string) => status.checks.find((c) => c.kind === kind);
  const activeFor = (k: string) => certs.filter((c) => c.kind === k && c.status === "active");

  async function call(
    fn: () => Promise<{ ok: boolean; errorKey?: string; okKey?: string }>,
    okText: string,
  ) {
    setBusy(true);
    setResult(null);
    try {
      const res = await fn();
      setResult(
        res.ok
          ? { ok: true, text: res.okKey ?? okText }
          : { ok: false, text: errText(errors, res.errorKey) },
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <section className="card space-y-3 p-5">
        <h3 className="flex items-center gap-2 font-semibold">
          <ShieldCheck className="h-4 w-4 text-primary" /> {t.taxPg.onboardingNow}
        </h3>
        <p className="text-xs leading-relaxed text-muted">{t.taxPg.onboardingAuto}</p>

        {/* step indicators */}
        <div className="flex flex-wrap gap-2 text-[11px]">
          {[
            [t.taxPg.stepDeviceKey, status.hasDeviceKey],
            [t.taxPg.stepCsr, Boolean(status.csr)],
            [t.taxPg.stepCompliance, Boolean(status.compliance)],
            [
              t.taxPg.stepChecks,
              status.checks.length > 0 && status.checks.every((c) => c.status === "passed"),
            ],
            [t.taxPg.stepProduction, Boolean(status.production)],
          ].map(([label, done]) => (
            <span key={String(label)} className={`rounded-lg px-2 py-1 font-semibold ${stepState(Boolean(done))}`}>
              {String(label)}: {done ? "✓" : "—"}
            </span>
          ))}
        </div>

        {status.complianceRequestId && (
          <p className="tnum text-[11px] text-muted" dir="ltr">
            {t.taxPg.complianceRequestId}: {status.complianceRequestId}
          </p>
        )}
        {status.production?.expiresAt && (
          <p className="text-[11px] text-muted">
            {t.taxPg.csidExpiry}: <span dir="ltr">{status.production.expiresAt.slice(0, 10)}</span>
            {status.production.daysLeft !== null && status.production.daysLeft <= 30 && (
              <span className="ms-2 rounded-lg bg-warning-soft px-2 py-0.5 font-semibold text-warning">
                {t.taxPg.certExpiresIn} {status.production.daysLeft} {t.taxPg.days}
              </span>
            )}
          </p>
        )}

        {/* the six checks */}
        {status.checks.length > 0 && (
          <div className="space-y-1.5">
            <p className="text-xs font-medium">{t.taxPg.checksTitle}</p>
            <ul className="grid gap-1.5 sm:grid-cols-2">
              {Object.entries(CHECK_LABELS).map(([kind, labelKey]) => {
                const c = checkOf(kind);
                const state = c?.status ?? "pending";
                return (
                  <li key={kind} className="flex items-center gap-2 rounded-lg bg-surface-2 px-3 py-2 text-[11px]">
                    {state === "passed" ? (
                      <CheckCircle2 className="h-3.5 w-3.5 text-success" />
                    ) : state === "failed" ? (
                      <XCircle className="h-3.5 w-3.5 text-danger" />
                    ) : (
                      <Clock className="h-3.5 w-3.5 text-muted" />
                    )}
                    <span className="flex-1">{t.taxPg[labelKey]}</span>
                    <span className="text-muted">
                      {state === "passed" ? t.taxPg.checkPassed : state === "failed" ? t.taxPg.checkFailed : t.taxPg.checkPending}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        {canConfigure && (
          <div className="space-y-3">
            <label className="block text-sm">
              <span className="mb-1 block font-medium">{t.taxPg.otp}</span>
              <ActionOtpField
                label={t.taxPg.startOnboarding}
                busy={busy}
                onSubmit={(otp) => call(() => startOnboardingAction(formOf({ otp })), t.taxPg.stepCompliance)}
              />
            </label>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                disabled={busy || !status.compliance}
                className="btn btn-secondary"
                onClick={() => call(runComplianceChecksAction, t.taxPg.checksTitle)}
              >
                {t.taxPg.runChecks}
              </button>
              <button
                type="button"
                disabled={busy || !status.canIssueProduction}
                className="btn btn-primary"
                onClick={() => call(issueProductionCsidAction, t.taxPg.stepProduction)}
              >
                {t.taxPg.issuePcsid}
              </button>
              <button
                type="button"
                disabled={busy || !status.production}
                className="btn btn-ghost"
                onClick={() => call(renewProductionCsidAction, t.taxPg.stepProduction)}
              >
                {t.taxPg.renewCsid}
              </button>
            </div>
          </div>
        )}
        <ResultBox result={result} />
      </section>

      {canConfigure && (
        <ManualCredentials t={t} errors={errors} certs={activeFor} />
      )}
    </div>
  );
}

/** OTP input + submit (kept separate so the panel stays readable). */
function ActionOtpField({
  label, busy, onSubmit,
}: { label: string; busy: boolean; onSubmit: (otp: string) => void }) {
  const [otp, setOtp] = useState("");
  return (
    <span className="flex gap-2">
      <input
        name="otp"
        value={otp}
        onChange={(e) => setOtp(e.target.value)}
        dir="ltr"
        inputMode="numeric"
        autoComplete="one-time-code"
        className="input"
        placeholder="123456"
      />
      <button
        type="button"
        disabled={busy || otp.trim().length < 6}
        className="btn btn-primary whitespace-nowrap"
        onClick={() => onSubmit(otp)}
      >
        {label}
      </button>
    </span>
  );
}

function formOf(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

/** Documented fallback: paste credentials issued by an external onboarding. */
function ManualCredentials({
  t, errors, certs,
}: { t: Dict; errors: Record<string, string>; certs: (k: string) => { env: string; kind: string; status: string; label: string | null }[] }) {
  const [kind, setKind] = useState("production");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

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
    <details className="card p-5">
      <summary className="flex cursor-pointer items-center gap-2 text-sm font-semibold">
        <KeyRound className="h-4 w-4 text-primary" /> {t.taxPg.manualFallback}
      </summary>
      <form onSubmit={onSubmit} className="mt-4 space-y-3">
        <input type="hidden" name="kind" value={kind} />
        <div className="grid grid-cols-2 gap-2 text-xs font-semibold">
          <button type="button" onClick={() => setKind("compliance")}
            className={`rounded-xl py-2 ${kind === "compliance" ? "bg-primary text-primary-foreground" : "bg-surface-2 text-muted"}`}>
            {t.taxPg.compliance} {certs("compliance").length > 0 ? "✓" : ""}
          </button>
          <button type="button" onClick={() => setKind("production")}
            className={`rounded-xl py-2 ${kind === "production" ? "bg-primary text-primary-foreground" : "bg-surface-2 text-muted"}`}>
            {t.taxPg.production} {certs("production").length > 0 ? "✓" : ""}
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
        <button type="submit" disabled={busy} className="btn btn-secondary">
          {busy ? t.common.loading : t.taxPg.saveCreds}
        </button>
        <ResultBox result={result} />
      </form>
    </details>
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
