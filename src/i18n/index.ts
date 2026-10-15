/**
 * Server-side locale resolution (cookies). Client components: import from
 * "@/i18n/dicts" instead — this module pulls next/headers.
 */

import { cookies } from "next/headers";
import { DEFAULT_LOCALE, LOCALE_COOKIE, type Locale } from "./dicts";

export { getDict, dirOf, DEFAULT_LOCALE, LOCALE_COOKIE, type Locale, type Dict } from "./dicts";

/** Resolve locale from cookie (server). Defaults to Arabic. */
export async function getLocale(): Promise<Locale> {
  const store = await cookies();
  const v = store.get(LOCALE_COOKIE)?.value;
  return v === "en" ? "en" : DEFAULT_LOCALE;
}
