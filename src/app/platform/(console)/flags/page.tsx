/**
 * Feature flags (PLATFORM_ADMIN §1.4): global switches and per-tenant overrides.
 *
 * Tenant overrides win over global. Every change is audited and takes effect on
 * the next request (flags are read per request, never cached across deploys).
 */

import { getLocale, getDict } from "@/i18n";
import { requirePlatformPermission, getPlatformContext } from "@/modules/platform/context";
import { listFlags, listTenants } from "@/modules/platform/tenants";
import { flagSetAction } from "@/modules/platform/actions";
import { ActionForm, Badge, Field, Table } from "../../ui";

export const dynamic = "force-dynamic";

export default async function FlagsPage() {
  const t = getDict(await getLocale()).platform;
  requirePlatformPermission(await getPlatformContext(), "platform.flags.view");

  const [flags, tenants] = await Promise.all([listFlags(), listTenants()]);
  const nameOf = (id: string | null) => (id ? (tenants.find((x) => x.id === id)?.name ?? id.slice(0, 8)) : t.global);

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl font-bold">{t.navFlags}</h1>
        <p className="text-xs text-muted">{t.flagsHint}</p>
      </header>

      <ActionForm action={flagSetAction} className="card p-4" submitLabel={t.set}>
        <h2 className="mb-3 text-sm font-bold">{t.setFlag}</h2>
        <div className="grid gap-3 sm:grid-cols-4">
          <Field label={t.scope}>
            <select className="input" name="tenantId" defaultValue="">
              <option value="">{t.global}</option>
              {tenants.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t.flagKey}>
            <input className="input" name="key" dir="ltr" required placeholder="reports.advanced" />
          </Field>
          <Field label={t.enabled}>
            <select className="input" name="enabled" defaultValue="true">
              <option value="true">ON</option>
              <option value="false">OFF</option>
            </select>
          </Field>
          <Field label={t.flagNote}>
            <input className="input" name="note" />
          </Field>
        </div>
      </ActionForm>

      <Table head={[t.scope, t.flagKey, t.statusLabel, t.flagNote, t.changedAt]}>
        {flags.map((f) => (
          <tr key={f.id} className="border-t border-border/60">
            <td className="px-3 py-2 text-sm">{nameOf(f.tenantId)}</td>
            <td className="px-3 py-2 font-mono text-xs" dir="ltr">
              {f.key}
            </td>
            <td className="px-3 py-2">
              <Badge tone={f.enabled ? "success" : "muted"}>{f.enabled ? "ON" : "OFF"}</Badge>
            </td>
            <td className="px-3 py-2 text-xs text-muted">{f.note ?? "—"}</td>
            <td className="px-3 py-2 text-xs">{f.updatedAt.toISOString().slice(0, 16).replace("T", " ")}</td>
          </tr>
        ))}
        {flags.length === 0 ? (
          <tr>
            <td className="px-3 py-3 text-muted" colSpan={5}>
              {t.noFlags}
            </td>
          </tr>
        ) : null}
      </Table>
    </div>
  );
}
