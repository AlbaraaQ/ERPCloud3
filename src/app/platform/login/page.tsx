/**
 * Platform sign-in (PLATFORM_ADMIN §0). Two factors from the start for the
 * Owner role; ops accounts may enrol on first sign-in. The page sits outside
 * the console shell so an unauthenticated visitor can reach it.
 */

import Link from "next/link";
import { getLocale, getDict } from "@/i18n";
import { LoginForm } from "./login-form";

export const dynamic = "force-dynamic";

export default async function PlatformLoginPage() {
  const locale = await getLocale();
  const t = getDict(locale).platform;

  return (
    <div className="grid min-h-screen place-items-center bg-surface-2/40 px-4">
      <div className="w-full max-w-sm">
        <div className="card p-6">
          <h1 className="text-lg font-bold">{t.login}</h1>
          <p className="mt-1 text-xs text-muted">{t.loginHint}</p>
          <LoginForm />
        </div>
        <p className="mt-3 text-center text-[11px] text-muted">
          <Link href="/login" className="underline">
            {t.tenantLink}
          </Link>
        </p>
      </div>
    </div>
  );
}
