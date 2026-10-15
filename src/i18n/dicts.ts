import { ar, type Dict } from "./ar";
import { en } from "./en";

/** Pure dictionaries — safe for BOTH server and client bundles. */

export type Locale = "ar" | "en";
export const DEFAULT_LOCALE: Locale = "ar";
export const LOCALE_COOKIE = "hisab_locale";

export type { Dict };

const dictionaries: Record<Locale, Dict> = { ar, en };

export function getDict(locale: Locale): Dict {
  return dictionaries[locale] ?? ar;
}

export function dirOf(locale: Locale): "rtl" | "ltr" {
  return locale === "ar" ? "rtl" : "ltr";
}
