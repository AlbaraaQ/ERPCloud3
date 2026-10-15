/**
 * Two-factor enrolment for platform users (PLATFORM_ADMIN §0).
 *
 * The pending token comes from a successful password check (set by the login
 * action) — enrolment therefore proves both factors before a console session
 * exists.
 */

import Link from "next/link";
import { getLocale, getDict } from "@/i18n";
import { EnrollForm } from "./enroll-form";

export const dynamic = "force-dynamic";

export default async function PlatformEnrollPage() {
  const t = getDict(await getLocale()).platform;
  return (
    <div className="grid min-h-screen place-items-center bg-surface-2/40 px-4">
      <div className="w-full max-w-sm">
        <div className="card p-6">
          <h1 className="text-lg font-bold">{t.enrollTitle}</h1>
          <p className="mt-1 text-xs text-muted">{t.totpHint}</p>
          <div className="mt-4">
            <EnrollForm />
          </div>
        </div>
        <p className="mt-3 text-center text-[11px] text-muted">
          <Link href="/platform/login" className="underline">
            {t.backToLogin}
          </Link>
        </p>
      </div>
    </div>
  );
}
