/**
 * AR subledger derivations (INV-08). Single source for exposure/outstanding/
 * advance — imported by both invoice and receipt engines (no cycles).
 */

import type { Trx } from "@/modules/shared/db-context";
import { Decimal, dec } from "@/modules/shared/money";
import { sql } from "drizzle-orm";

/** Σ posted sales − posted returns − allocations (customer exposure). */
export async function customerExposure(trx: Trx, tenantId: string, customerId: string): Promise<Decimal> {
  const res = await trx.execute(sql`
    select (
      coalesce((select sum(total) from sales_invoices
                where tenant_id = ${tenantId} and customer_id = ${customerId}
                  and business_status = 'posted' and invoice_type = 'sale'), 0)
      - coalesce((select sum(total) from sales_invoices
                where tenant_id = ${tenantId} and customer_id = ${customerId}
                  and business_status = 'posted' and invoice_type = 'sale_return'), 0)
      - coalesce((select sum(a.amount) from allocations a
                join sales_invoices i on i.id = a.invoice_id
                where a.tenant_id = ${tenantId} and i.customer_id = ${customerId}
                  and i.invoice_type = 'sale'), 0)
    )::text as exposure
  `);
  const row = (res as unknown as { rows: { exposure: string }[] }).rows[0];
  return dec(row.exposure);
}

/** Receipt advances minus advance applications. */
export async function advanceBalance(trx: Trx, tenantId: string, customerId: string): Promise<Decimal> {
  const res = await trx.execute(sql`
    select (
      coalesce((select sum(advance_amount) from receipts
                where tenant_id = ${tenantId} and customer_id = ${customerId} and status='posted'), 0)
      - coalesce((select sum(a.amount) from allocations a
                join sales_invoices i on i.id = a.invoice_id and i.customer_id = ${customerId}
                where a.tenant_id = ${tenantId} and a.is_advance_application = true), 0)
    )::text as advance
  `);
  const row = (res as unknown as { rows: { advance: string }[] }).rows[0];
  return dec(row.advance);
}

/** Outstanding of one posted invoice (guarded by invoice row lock by callers). */
export async function invoiceOutstanding(trx: Trx, tenantId: string, invoiceId: string): Promise<Decimal> {
  const res = await trx.execute(sql`
    select (i.total - coalesce((select sum(a.amount) from allocations a
        where a.tenant_id = i.tenant_id and a.invoice_id = i.id), 0))::text as outstanding
    from sales_invoices i
    where i.tenant_id = ${tenantId} and i.id = ${invoiceId}
  `);
  const row = (res as unknown as { rows: { outstanding: string }[] }).rows[0];
  return dec(row?.outstanding ?? "0");
}
