import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { and, eq, isNull, count } from "drizzle-orm";
import { getSessionContext } from "@/modules/identity/auth";
import { withTenant } from "@/modules/shared/db-context";
import { notifications } from "@/db/schema";
import { getLocale, getDict } from "@/i18n";
import { aiGloballyEnabled, getAiConfig } from "@/modules/ai/config";
import { AppShell } from "@/components/shell/app-shell";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: ReactNode }) {
  const ctx = await getSessionContext();
  if (!ctx || !ctx.tenant) redirect("/login");

  const locale = await getLocale();
  const t = getDict(locale);

  // Nav visibility for the assistant: the tenant's own switch AND the platform
  // flag (AI_ASSISTANT §6). The page itself re-checks availability server-side —
  // a hidden link is convenience, never a control.
  const aiConfig = await getAiConfig(ctx.tenant.id);
  const assistantEnabled = aiConfig.enabled && (await aiGloballyEnabled(ctx.tenant.id));

  const [unread] = await withTenant(ctx.tenant.id, (trx) =>
    trx
      .select({ n: count() })
      .from(notifications)
      .where(and(eq(notifications.userId, ctx.userId!), isNull(notifications.readAt))),
  );

  return (
    <AppShell
      t={t}
      userName={ctx.userName}
      userEmail={ctx.userEmail}
      tenantName={ctx.tenant.name}
      tenantStatus={ctx.tenant.status}
      permissions={[...ctx.permissions]}
      unreadNotifications={unread?.n ?? 0}
      locale={locale}
      assistantEnabled={assistantEnabled}
    >
      {children}
    </AppShell>
  );
}
