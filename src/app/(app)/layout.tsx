import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { and, eq, isNull, count } from "drizzle-orm";
import { getSessionContext } from "@/modules/identity/auth";
import { withTenant } from "@/modules/shared/db-context";
import { notifications } from "@/db/schema";
import { getLocale, getDict } from "@/i18n";
import { AppShell } from "@/components/shell/app-shell";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: ReactNode }) {
  const ctx = await getSessionContext();
  if (!ctx || !ctx.tenant) redirect("/login");

  const locale = await getLocale();
  const t = getDict(locale);

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
    >
      {children}
    </AppShell>
  );
}
