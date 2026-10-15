/**
 * Pricing resolution & boundaries (FR-036/037). Entering a different price
 * NEVER mutates the master price; overrides are recorded with all audit fields.
 */

import { and, desc, eq, gte, isNull, lte, or } from "drizzle-orm";
import { customerPrices, products } from "@/db/schema";
import type { Trx } from "@/modules/shared/db-context";
import { errors } from "@/modules/shared/result";
import { dec, gte as decGte, lte as decLte } from "@/modules/shared/money";

export interface ResolvedPrice {
  price: string;
  source: "customer" | "product";
}

/** Resolution order: latest effective customer price → product sale price. */
export async function resolveSalePrice(
  trx: Trx,
  tenantId: string,
  args: { customerId: string | null; productId: string; onDate: string },
): Promise<ResolvedPrice> {
  if (args.customerId) {
    const [cp] = await trx
      .select({ price: customerPrices.price })
      .from(customerPrices)
      .where(
        and(
          eq(customerPrices.tenantId, tenantId),
          eq(customerPrices.customerId, args.customerId),
          eq(customerPrices.productId, args.productId),
          lte(customerPrices.effectiveFrom, args.onDate),
          or(isNull(customerPrices.effectiveTo), gte(customerPrices.effectiveTo, args.onDate)),
        ),
      )
      .orderBy(desc(customerPrices.effectiveFrom))
      .limit(1);
    if (cp) return { price: cp.price, source: "customer" };
  }
  const [p] = await trx
    .select({ salePrice: products.salePrice })
    .from(products)
    .where(and(eq(products.tenantId, tenantId), eq(products.id, args.productId)))
    .limit(1);
  if (!p) throw errors.notFound("product", args.productId);
  return { price: p.salePrice, source: "product" };
}

export interface PriceCheck {
  within: boolean;
  violation: "below_min" | "above_max" | null;
  min: string | null;
  max: string | null;
}

/** Are we within the admin-defined price band for this product? (FR-036) */
export function checkPriceBoundaries(
  product: { salePrice: string; minPrice: string | null; maxPrice: string | null },
  requested: string,
): PriceCheck {
  const req = dec(requested);
  if (product.minPrice != null && req.lt(dec(product.minPrice))) {
    return { within: false, violation: "below_min", min: product.minPrice, max: product.maxPrice };
  }
  if (product.maxPrice != null && req.gt(dec(product.maxPrice))) {
    return { within: false, violation: "above_max", min: product.minPrice, max: product.maxPrice };
  }
  return { within: true, violation: null, min: product.minPrice, max: product.maxPrice };
}

export const VAT_RATES: Record<string, string> = {
  standard: "0.15",
  zero: "0",
  exempt: "0",
};

export function vatRateFor(taxCategory: string): string {
  const rate = VAT_RATES[taxCategory];
  if (rate === undefined) {
    // unknown category → configuration error, never silently exempt (INV-17)
    throw errors.configuration("errors.taxCategoryUnknown", taxCategory);
  }
  return rate;
}
