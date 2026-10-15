/**
 * Dates & time (D-016): instants stored as UTC timestamptz; every business
 * document carries `business_date` in the tenant timezone (default Asia/Riyadh).
 */

export const DEFAULT_TZ = "Asia/Riyadh";

const fmtCache = new Map<string, Intl.DateTimeFormat>();

function tzFormat(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    fmtCache.set(tz, f);
  }
  return f;
}

/** Tenant-local business date YYYY-MM-DD for a given instant. */
export function businessDate(instant: Date = new Date(), tz: string = DEFAULT_TZ): string {
  return tzFormat(tz).format(instant);
}

/** Today's business date in tenant timezone. */
export const todayBusinessDate = (tz?: string) => businessDate(new Date(), tz);

export function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function monthOf(isoDate: string): string {
  return isoDate.slice(0, 7);
}

/** Inclusive range helpers used by reports (business_date semantics). */
export function monthRange(yearMonth: string): { from: string; to: string } {
  const [y, m] = yearMonth.split("-").map(Number);
  const from = `${yearMonth}-01`;
  const to = addDays(new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10), 0);
  return { from, to };
}

export function isValidISODate(v: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(new Date(`${v}T00:00:00Z`).getTime());
}
