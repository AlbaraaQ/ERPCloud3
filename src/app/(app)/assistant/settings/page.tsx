/**
 * Assistant settings (AI_ASSISTANT §1, §5).
 *
 * Only `settings.company.manage` reaches this screen — and the action re-checks it,
 * so hiding the link is convenience rather than the control.
 */

import { redirect } from "next/navigation";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { getSessionContext } from "@/modules/identity/auth";
import { getLocale, getDict } from "@/i18n";
import { getAiConfig, assistantTenantWritable } from "@/modules/ai/config";
import { PROVIDER_IDS } from "@/modules/ai/providers";
import { AssistantSettingsForm } from "./settings-form";

export const dynamic = "force-dynamic";

export default async function AssistantSettingsPage() {
  const ctx = await getSessionContext();
  if (!ctx || !ctx.tenant || !ctx.userId) redirect("/login");

  const locale = await getLocale();
  const t = getDict(locale);
  const errors = t.errors as unknown as Record<string, string>;

  if (!ctx.permissions.has("settings.company.manage")) {
    return (
      <div className="card p-4">
        <h1 className="text-lg font-bold">{t.ai.settingsTitle}</h1>
        <p className="mt-2 text-sm text-danger">{errors.permissionDenied}</p>
      </div>
    );
  }

  const config = await getAiConfig(ctx.tenant.id);
  const writable = await assistantTenantWritable(ctx.tenant.id);

  return (
    <div className="space-y-4">
      <Link href="/assistant" className="btn btn-ghost">
        <ArrowRight className="h-4 w-4 rotate-180 rtl:rotate-0" aria-hidden />
        {t.ai.title}
      </Link>

      {!writable ? <p className="text-sm text-warning">{errors.aiTenantReadOnly}</p> : null}

      <AssistantSettingsForm
        t={{
          settingsTitle: t.ai.settingsTitle,
          settingsSubtitle: t.ai.settingsSubtitle,
          enabledLabel: t.ai.enabledLabel,
          provider: t.ai.provider,
          model: t.ai.model,
          baseUrl: t.ai.baseUrl,
          secretRef: t.ai.secretRef,
          secretRefHint: t.ai.secretRefHint,
          dataScope: t.ai.dataScope,
          dataScopeMetrics: t.ai.dataScopeMetrics,
          dataScopeNames: t.ai.dataScopeNames,
          retentionDays: t.ai.retentionDays,
          save: t.ai.save,
          settingsSaved: t.ai.settingsSaved,
        }}
        errors={errors}
        config={{
          enabled: config.enabled,
          provider: config.provider,
          model: config.model,
          baseUrl: config.baseUrl,
          secretRef: config.secretRef,
          dataScope: config.dataScope,
          retentionDays: config.retentionDays,
        }}
        providers={PROVIDER_IDS}
      />
    </div>
  );
}
