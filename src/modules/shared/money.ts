/**
 * Money — decimal-only arithmetic (D-003).
 * Binary floats are forbidden for money/quantities anywhere in the codebase.
 */

import Decimal from "decimal.js";

export { Decimal };
export type MoneyValue = Decimal.Value;

Decimal.set({
  precision: 40,
  rounding: Decimal.ROUND_HALF_UP,
  toExpNeg: -30,
  toExpPos: 40,
});

/** Currency minor units (D-003). SAR default = 2 halalas. */
export const CURRENCY_DECIMALS: Record<string, number> = {
  SAR: 2,
  USD: 2,
  EUR: 2,
  AED: 2,
  KWD: 3,
};

export function dec(value: MoneyValue | null | undefined): Decimal {
  if (value === null || value === undefined || value === "") return new Decimal(0);
  const d = new Decimal(value);
  if (!d.isFinite()) throw new Error(`Invalid decimal: ${String(value)}`);
  return d;
}

export const add = (a: MoneyValue, b: MoneyValue) => dec(a).plus(b);
export const sub = (a: MoneyValue, b: MoneyValue) => dec(a).minus(b);
export const mul = (a: MoneyValue, b: MoneyValue) => dec(a).times(b);
export const div = (a: MoneyValue, b: MoneyValue) => dec(a).dividedBy(b);
export const sum = (vals: MoneyValue[]) =>
  vals.reduce<Decimal>((acc, v) => acc.plus(dec(v)), new Decimal(0));

/** Round to the currency's minor units, HALF_UP (line-level rounding rule). */
export function roundMoney(value: MoneyValue, currency = "SAR"): Decimal {
  const places = CURRENCY_DECIMALS[currency] ?? 2;
  return dec(value).toDecimalPlaces(places, Decimal.ROUND_HALF_UP);
}

/** Quantities: NUMERIC(18,6) semantics. */
export function roundQty(value: MoneyValue): Decimal {
  return dec(value).toDecimalPlaces(6, Decimal.ROUND_HALF_UP);
}

export const isZero = (v: MoneyValue) => dec(v).isZero();
export const isNegative = (v: MoneyValue) => dec(v).isNegative();
export const gt = (a: MoneyValue, b: MoneyValue) => dec(a).gt(dec(b));
export const gte = (a: MoneyValue, b: MoneyValue) => dec(a).gte(dec(b));
export const lt = (a: MoneyValue, b: MoneyValue) => dec(a).lt(dec(b));
export const lte = (a: MoneyValue, b: MoneyValue) => dec(a).lte(dec(b));
export const eqMoney = (a: MoneyValue, b: MoneyValue) => dec(a).eq(dec(b));

/** Persist: plain decimal string (never exponential, never float). */
export function toDb(value: MoneyValue): string {
  return dec(value).toFixed();
}

export function formatMoney(value: MoneyValue, currency = "SAR"): string {
  return roundMoney(value, currency).toFixed(CURRENCY_DECIMALS[currency] ?? 2);
}

/** Assert Σ debits === Σ credits (INV-01). */
export function assertBalanced(debits: MoneyValue[], credits: MoneyValue[], currency = "SAR") {
  const d = roundMoney(sum(debits), currency);
  const c = roundMoney(sum(credits), currency);
  if (!d.eq(c)) {
    throw new Error(`Journal not balanced: dr=${d.toFixed()} cr=${c.toFixed()}`);
  }
}
