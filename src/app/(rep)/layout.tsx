import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { getSessionContext } from "@/modules/identity/auth";
import { getLocale, getDict } from "@/i18n";
import { RepShell } from "./rep-shell";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  manifest: "/manifest.webmanifest",
  title: "مندوب المبيعات — حِساب",
};

export default async function RepLayout({ children }: { children: ReactNode }) {
  const ctx = await getSessionContext();
  if (!ctx?.tenant) redirect("/login");
  const locale = await getLocale();
  const t = getDict(locale);

  return (
    <RepShell
      t={t}
      userName={ctx.userName}
      tenantName={ctx.tenant.name}
      errors={t.errors as unknown as Record<string, string>}
    >
      {children}
    </RepShell>
  );
}
