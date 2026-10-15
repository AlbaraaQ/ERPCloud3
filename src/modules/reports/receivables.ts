/**
 * AR/AP reports (REPORTING_SPECIFICATION §2 R-08/R-21/R-26).
 *
 * Single source per figure (INV-08/INV-13): the subledger figure for a document is
 * `total − Σ allocations` — the SAME formula the application enforces when it
 * guards receipts (`modules/sales/balances.invoiceOutstanding`,
 * `modules/purchasing/purchases.purchaseOutstanding`). The reports compute it
 * set-based for the whole tenant; a test asserts the two paths agree per document,
 * so a report can never drift from the guard that blocks over-allocation.
 *
 * DOCUMENT SET (this is what makes RL-2 hold): the set is taken FROM THE POSTINGS on the
 * control account — every document whose journal entry touched AR/AP is included, with
 * the sign of its own posting, and nothing else. This matters: a sale to a registered
 * walk-in (customer set, `is_credit = false`) still debits AR, and a credit note credits
 * AR even when the original sale was a walk-in one. Deriving the set from the ledger
 * instead of guessing from `is_credit`/`customer_id` is what keeps the subledger and the
 * control account identical by construction rather than by coincidence.
 *
 * Allocations are then subtracted (receipts/advances mirror them on the control account),
 * so `Σ signed documents − Σ allocations = control balance` and RL-2 checks the two
 * figures the reports actually show.
 */

import { sql } from "drizzle-orm";
import type { Trx } from "@/modules/shared/db-context";
import { round2 } from "./ledger";
import { resolveReportAccount } from "./accounts";

export interface AgingBucket {
  current: number;
  d1_30: number;
  d31_60: number;
  d61_90: number;
  d90_plus: number;
  total: number;
}

export interface AgingRow extends AgingBucket {
  partyId: string;
  partyCode: string;
  partyName: string;
  documents: number;
  /** oldest unpaid due date, when any */
  oldestDueDate: string | null;
}

export interface AgingReport {
  rows: AgingRow[];
  buckets: AgingBucket;
  totalOutstanding: number;
  totalPayable: number;
  asOf: string;
  coverageNote?: string;
}

function emptyBuckets(): AgingBucket {
  return { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0, total: 0 };
}

function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  return Math.floor((b - a) / 86_400_000);
}

function addToBucket(bucket: AgingBucket, overdueDays: number, amount: number): void {
  if (overdueDays <= 0) bucket.current = round2(bucket.current + amount);
  else if (overdueDays <= 30) bucket.d1_30 = round2(bucket.d1_30 + amount);
  else if (overdueDays <= 60) bucket.d31_60 = round2(bucket.d31_60 + amount);
  else if (overdueDays <= 90) bucket.d61_90 = round2(bucket.d61_90 + amount);
  else bucket.d90_plus = round2(bucket.d90_plus + amount);
  bucket.total = round2(bucket.total + amount);
}

/**
 * R-08 Accounts receivable aging + R-26 detail.
 * `asOf` is a business date; postings after it are ignored (documents are dated by
 * their own `business_date`, mirroring the ledger's date semantics).
 */
export async function arAging(
  trx: Trx,
  tenantId: string,
  opts: { asOf: string },
): Promise<AgingReport> {
  const ar = await resolveReportAccount(trx, tenantId, "ar_control", "1103");
  if (!ar) {
    return { rows: [], buckets: emptyBuckets(), totalOutstanding: 0, totalPayable: 0, asOf: opts.asOf, coverageNote: "ar_control mapping missing" };
  }

  const rows = await trx.execute(sql`
    with ar_docs as (
      select distinct e.source_id as doc_id
      from journal_entries e
      join journal_lines l on l.entry_id = e.id
      where e.tenant_id = ${tenantId} and e.status = 'posted' and l.account_id = ${ar.id}
        and e.source_type in ('sales_invoice', 'sales_return')
    ),
    ar_posts as (
      select e.source_id as doc_id, sum(l.debit - l.credit) as ar_net
      from journal_entries e
      join journal_lines l on l.entry_id = e.id
      where e.tenant_id = ${tenantId} and e.status = 'posted' and l.account_id = ${ar.id}
        and e.source_type in ('sales_invoice', 'sales_return')
      group by e.source_id
    )
    select i.id, i.invoice_no, i.customer_id, c.code, c.name_ar, i.due_date, i.business_date,
           i.invoice_type, i.total::text as total,
           coalesce(p.ar_net, 0)::text as ar_net,
           coalesce((select sum(a.amount) from allocations a
                     where a.tenant_id = ${tenantId} and a.invoice_id = i.id), 0)::text as alloc,
           -- allocations sitting on documents the control account never saw
           (select coalesce(sum(a2.amount), 0) from allocations a2
             where a2.tenant_id = ${tenantId}
               and not exists (select 1 from ar_docs d2 where d2.doc_id = a2.invoice_id))::text as orphan
    from sales_invoices i
    left join customers c on c.id = i.customer_id
    left join ar_posts p on p.doc_id = i.id
    where i.tenant_id = ${tenantId} and i.business_status = 'posted'
      and i.business_date <= ${opts.asOf}
      and i.id in (select doc_id from ar_docs)
    order by i.business_date, i.invoice_no
  `);
  const docs = (rows as unknown as {
    rows: {
      id: string;
      invoice_no: string | null;
      customer_id: string | null;
      code: string | null;
      name_ar: string | null;
      due_date: string | null;
      business_date: string;
      invoice_type: string;
      total: string;
      ar_net: string;
      alloc: string;
      orphan: string;
    }[];
  }).rows;

  const orphan = docs.length > 0 ? Number(docs[0].orphan) : 0;
  const byParty = new Map<string, AgingRow>();
  const buckets = emptyBuckets();
  let totalOutstanding = 0;
  let noDueDate = 0;
  for (const doc of docs) {
    // the sign is the posting's own direction: a credit note credits AR (negative)
    const signed = Number(doc.ar_net) >= 0 ? Number(doc.total) : -Number(doc.total);
    const outstanding = round2(signed - Number(doc.alloc));
    if (Math.abs(outstanding) < 0.005) continue;
    const partyId = doc.customer_id ?? "walk-in";
    const entry =
      byParty.get(partyId) ??
      (({
        partyId,
        partyCode: doc.code ?? "—",
        partyName: doc.name_ar ?? "عميل نقدي (بدون ذمة)",
        documents: 0,
        oldestDueDate: null,
        ...emptyBuckets(),
      }) as AgingRow);
    const due = doc.due_date;
    if (!due) noDueDate += 1;
    const overdueDays = due ? daysBetween(due, opts.asOf) : 0;
    addToBucket(entry, overdueDays, outstanding);
    addToBucket(buckets, overdueDays, outstanding);
    entry.documents += 1;
    if (due && (!entry.oldestDueDate || due < entry.oldestDueDate)) entry.oldestDueDate = due;
    byParty.set(partyId, entry);
    totalOutstanding = round2(totalOutstanding + outstanding);
  }

  return {
    rows: [...byParty.values()].sort((a, b) => b.total - a.total),
    buckets,
    totalOutstanding: round2(totalOutstanding - orphan),
    totalPayable: 0,
    asOf: opts.asOf,
    coverageNote: [
      noDueDate > 0 ? `${noDueDate} invoice(s) without a due date are shown as current` : null,
      orphan !== 0 ? `${orphan} allocated outside the control-account documents` : null,
    ]
      .filter(Boolean)
      .join(" · ") || undefined,
  };
}

/** AP aging (supplier invoices minus supplier allocations). */
export async function apAging(
  trx: Trx,
  tenantId: string,
  opts: { asOf: string },
): Promise<AgingReport> {
  const ap = await resolveReportAccount(trx, tenantId, "ap_control", "2101");
  if (!ap) {
    return { rows: [], buckets: emptyBuckets(), totalOutstanding: 0, totalPayable: 0, asOf: opts.asOf, coverageNote: "ap_control mapping missing" };
  }
  const rows = await trx.execute(sql`
    with ap_docs as (
      select distinct e.source_id as doc_id
      from journal_entries e
      join journal_lines l on l.entry_id = e.id
      where e.tenant_id = ${tenantId} and e.status = 'posted' and l.account_id = ${ap.id}
        and e.source_type in ('purchase_invoice', 'purchase_return')
    ),
    ap_posts as (
      select e.source_id as doc_id, sum(l.debit - l.credit) as ap_net
      from journal_entries e
      join journal_lines l on l.entry_id = e.id
      where e.tenant_id = ${tenantId} and e.status = 'posted' and l.account_id = ${ap.id}
        and e.source_type in ('purchase_invoice', 'purchase_return')
      group by e.source_id
    )
    select p.id, p.invoice_no, p.supplier_id, s.code, s.name_ar, p.due_date, p.business_date,
           p.is_return, p.total::text as total,
           coalesce(x.ap_net, 0)::text as ap_net,
           coalesce((select sum(a.amount) from supplier_allocations a
                     where a.tenant_id = ${tenantId} and a.purchase_invoice_id = p.id), 0)::text as alloc
    from purchase_invoices p
    left join suppliers s on s.id = p.supplier_id
    left join ap_posts x on x.doc_id = p.id
    where p.tenant_id = ${tenantId} and p.status = 'posted'
      and p.business_date <= ${opts.asOf}
      and p.id in (select doc_id from ap_docs)
    order by p.business_date, p.invoice_no
  `);
  const docs = (rows as unknown as {
    rows: {
      id: string;
      supplier_id: string;
      code: string | null;
      name_ar: string | null;
      due_date: string | null;
      business_date: string;
      is_return: boolean;
      total: string;
      ap_net: string;
      alloc: string;
    }[];
  }).rows;

  const byParty = new Map<string, AgingRow>();
  const buckets = emptyBuckets();
  let totalPayable = 0;
  let noDueDate = 0;
  for (const doc of docs) {
    // AP is a credit balance: a supplier invoice is negative from the ledger's point of
    // view, a purchase return is positive. The payable shown is the inverse sign.
    const signed = Number(doc.ap_net) <= 0 ? Number(doc.total) : -Number(doc.total);
    const outstanding = round2(signed - Number(doc.alloc));
    if (Math.abs(outstanding) < 0.005) continue;
    const entry =
      byParty.get(doc.supplier_id) ??
      (({
        partyId: doc.supplier_id,
        partyCode: doc.code ?? "—",
        partyName: doc.name_ar ?? "—",
        documents: 0,
        oldestDueDate: null,
        ...emptyBuckets(),
      }) as AgingRow);
    if (!doc.due_date) noDueDate += 1;
    const overdueDays = doc.due_date ? daysBetween(doc.due_date, opts.asOf) : 0;
    addToBucket(entry, overdueDays, outstanding);
    addToBucket(buckets, overdueDays, outstanding);
    entry.documents += 1;
    if (doc.due_date && (!entry.oldestDueDate || doc.due_date < entry.oldestDueDate)) {
      entry.oldestDueDate = doc.due_date;
    }
    byParty.set(doc.supplier_id, entry);
    totalPayable = round2(totalPayable + outstanding);
  }

  return {
    rows: [...byParty.values()].sort((a, b) => b.total - a.total),
    buckets,
    totalOutstanding: 0,
    totalPayable,
    asOf: opts.asOf,
    coverageNote: noDueDate > 0 ? `${noDueDate} invoice(s) without a due date are shown as current` : undefined,
  };
}

/** Both sides in one call — the shape RL-2 consumes. */
export async function arApAging(
  trx: Trx,
  tenantId: string,
  opts: { asOf: string },
): Promise<{ ar: AgingReport; ap: AgingReport }> {
  const ar = await arAging(trx, tenantId, opts);
  const ap = await apAging(trx, tenantId, opts);
  return { ar, ap };
}

/** AR/AP aging table rows with the party name — used by the UI and the tests. */
export async function outstandingDocuments(
  trx: Trx,
  tenantId: string,
  opts: { asOf: string; limit?: number },
): Promise<
  { invoiceId: string; invoiceNo: number; party: string; dueDate: string | null; outstanding: number; businessDate: string }[]
> {
  const ar = await resolveReportAccount(trx, tenantId, "ar_control", "1103");
  if (!ar) return [];
  const rows = await trx.execute(sql`
    with ar_docs as (
      select distinct e.source_id as doc_id, sum(l.debit - l.credit) as ar_net
      from journal_entries e
      join journal_lines l on l.entry_id = e.id
      where e.tenant_id = ${tenantId} and e.status = 'posted' and l.account_id = ${ar.id}
        and e.source_type in ('sales_invoice', 'sales_return')
      group by e.source_id
    )
    select i.id, i.invoice_no, coalesce(c.name_ar, '—') as party, i.due_date, i.business_date,
           ((case when d.ar_net >= 0 then 1 else -1 end) * i.total
             - coalesce((select sum(a.amount) from allocations a
                         where a.tenant_id = ${tenantId} and a.invoice_id = i.id), 0))::text as outstanding
    from sales_invoices i
    join ar_docs d on d.doc_id = i.id
    left join customers c on c.id = i.customer_id
    where i.tenant_id = ${tenantId} and i.business_status = 'posted' and i.business_date <= ${opts.asOf}
    order by i.business_date
    limit ${opts.limit ?? 200}
  `);
  return (rows as unknown as {
    rows: {
      id: string;
      invoice_no: string | null;
      party: string;
      due_date: string | null;
      business_date: string;
      outstanding: string;
    }[];
  }).rows
    .map((r) => ({
      invoiceId: r.id,
      invoiceNo: r.invoice_no === null ? 0 : Number(r.invoice_no),
      party: r.party,
      dueDate: r.due_date,
      businessDate: r.business_date,
      outstanding: round2(Number(r.outstanding)),
    }))
    .filter((r) => Math.abs(r.outstanding) >= 0.005);
}
