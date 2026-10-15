/**
 * Chart of accounts — tenant template per ACCOUNTING_POLICY.md §3.
 * Codes below are the seeded template; tenants may add accounts but required
 * posting accounts are resolved via posting_mappings keys (never guessed).
 */

import { and, eq } from "drizzle-orm";
import { accounts, postingMappings } from "@/db/schema";
import type { Trx } from "@/modules/shared/db-context";

type AcctType = "asset" | "liability" | "equity" | "revenue" | "expense";

interface CoaRow {
  code: string;
  nameAr: string;
  nameEn?: string;
  type: AcctType;
  group?: boolean;
  control?: boolean;
  parent?: string;
}

export const COA_TEMPLATE: CoaRow[] = [
  { code: "1", nameAr: "الأصول", nameEn: "Assets", type: "asset", group: true },
  { code: "11", nameAr: "الأصول المتداولة", nameEn: "Current assets", type: "asset", group: true, parent: "1" },
  { code: "1101", nameAr: "الصناديق", nameEn: "Cashboxes", type: "asset", control: true, parent: "11" },
  { code: "1102", nameAr: "البنوك", nameEn: "Banks", type: "asset", control: true, parent: "11" },
  { code: "1103", nameAr: "مدينون / ذمم العملاء", nameEn: "Accounts receivable", type: "asset", control: true, parent: "11" },
  { code: "1104", nameAr: "المخزون", nameEn: "Inventory", type: "asset", control: true, parent: "11" },
  { code: "1105", nameAr: "عُهد المندوبين النقدية", nameEn: "Rep cash custody", type: "asset", parent: "11" },
  { code: "1106", nameAr: "ض.ق.م — مشتريات (مدخلات)", nameEn: "Input VAT", type: "asset", parent: "11" },
  { code: "1107", nameAr: "دفعات مقدمة للموردين", nameEn: "Supplier advances", type: "asset", parent: "11" },
  { code: "1108", nameAr: "مدينون متنوعون / سلف الموظفين", nameEn: "Other receivables", type: "asset", parent: "11" },
  { code: "1109", nameAr: "إنتاج تحت التشغيل", nameEn: "Work in progress", type: "asset", parent: "11" },
  { code: "2", nameAr: "الالتزامات", nameEn: "Liabilities", type: "liability", group: true },
  { code: "2101", nameAr: "دائنون / ذمم الموردون", nameEn: "Accounts payable", type: "liability", control: true, parent: "2" },
  { code: "2102", nameAr: "ض.ق.م — مبيعات (مخرجات)", nameEn: "Output VAT", type: "liability", parent: "2" },
  { code: "2103", nameAr: "دفعات مقدمة من العملاء", nameEn: "Customer advances", type: "liability", parent: "2" },
  { code: "2104", nameAr: "مصروفات مستحقة", nameEn: "Accrued expenses", type: "liability", parent: "2" },
  { code: "2105", nameAr: "رواتب مستحقة", nameEn: "Payroll payable", type: "liability", parent: "2" },
  { code: "3", nameAr: "حقوق الملكية", nameEn: "Equity", type: "equity", group: true },
  { code: "3101", nameAr: "رأس المال / أرصدة افتتاحية", nameEn: "Capital / opening equity", type: "equity", parent: "3" },
  { code: "4", nameAr: "الإيرادات", nameEn: "Revenue", type: "revenue", group: true },
  { code: "4101", nameAr: "مبيعات", nameEn: "Sales", type: "revenue", control: true, parent: "4" },
  { code: "4102", nameAr: "مردودات المبيعات", nameEn: "Sales returns", type: "revenue", parent: "4" },
  { code: "4103", nameAr: "خصومات مسموحة", nameEn: "Sales discounts", type: "revenue", parent: "4" },
  { code: "5", nameAr: "التكاليف والمصروفات", nameEn: "Costs & expenses", type: "expense", group: true },
  { code: "5101", nameAr: "تكلفة البضاعة المباعة", nameEn: "COGS", type: "expense", control: true, parent: "5" },
  { code: "5102", nameAr: "بضاعة مجانية / عينات", nameEn: "Free goods expense", type: "expense", parent: "5" },
  { code: "5103", nameAr: "فروقات التسوية المخزنية", nameEn: "Settlement inventory adjustments", type: "expense", parent: "5" },
  { code: "5104", nameAr: "هالك / تالف", nameEn: "Scrap & damage", type: "expense", parent: "5" },
  { code: "5105", nameAr: "خسائر غير طبيعية", nameEn: "Abnormal losses", type: "expense", parent: "5" },
  { code: "5106", nameAr: "مصروفات تشغيل", nameEn: "Operating expenses", type: "expense", control: true, parent: "5" },
  { code: "5107", nameAr: "فرق التقريب", nameEn: "Rounding differences", type: "expense", parent: "5" },
  { code: "5108", nameAr: "عمولات المندوبين", nameEn: "Rep commissions", type: "expense", parent: "5" },
  { code: "5201", nameAr: "حساب تسوية الإنتاج", nameEn: "Production clearing", type: "expense", control: true, parent: "5" },
];

/** Posting-mapping keys required by the posting engine (INV-17 surface). */
export interface MappingKeyDef {
  key: string;
  nameAr: string;
  defaultCode: string;
}

export const MAPPING_KEYS: MappingKeyDef[] = [
  { key: "sales", nameAr: "حساب المبيعات", defaultCode: "4101" },
  { key: "sales_returns", nameAr: "مردودات المبيعات", defaultCode: "4102" },
  { key: "sales_discounts", nameAr: "الخصومات المسموحة", defaultCode: "4103" },
  { key: "ar_control", nameAr: "ذمم العملاء (مدينون)", defaultCode: "1103" },
  { key: "ap_control", nameAr: "ذمم الموردون (دائنون)", defaultCode: "2101" },
  { key: "inventory_control", nameAr: "المخزون", defaultCode: "1104" },
  { key: "cogs", nameAr: "تكلفة البضاعة المباعة", defaultCode: "5101" },
  { key: "output_vat", nameAr: "ض.ق.م مخرجات", defaultCode: "2102" },
  { key: "input_vat", nameAr: "ض.ق.م مدخلات", defaultCode: "1106" },
  { key: "cash_default", nameAr: "الصندوق الافتراضي", defaultCode: "1101" },
  { key: "bank_default", nameAr: "البنك الافتراضي", defaultCode: "1102" },
  { key: "free_goods_expense", nameAr: "مصروف البضاعة المجانية", defaultCode: "5102" },
  { key: "settlement_inventory_adj", nameAr: "فروقات التسوية المخزنية", defaultCode: "5103" },
  { key: "scrap_expense", nameAr: "هالك / تالف", defaultCode: "5104" },
  { key: "abnormal_loss", nameAr: "خسائر غير طبيعية", defaultCode: "5105" },
  { key: "expense_default", nameAr: "مصروفات التشغيل", defaultCode: "5106" },
  { key: "rounding_difference", nameAr: "فرق التقريب", defaultCode: "5107" },
  { key: "commissions", nameAr: "عمولات المندوبين", defaultCode: "5108" },
  { key: "production_clearing", nameAr: "تسوية الإنتاج", defaultCode: "5201" },
  { key: "wip", nameAr: "إنتاج تحت التشغيل", defaultCode: "1109" },
  { key: "opening_equity", nameAr: "أرصدة افتتاحية", defaultCode: "3101" },
  { key: "customer_advances", nameAr: "دفعات مقدمة من العملاء", defaultCode: "2103" },
  { key: "supplier_advances", nameAr: "دفعات مقدمة للموردين", defaultCode: "1107" },
  { key: "employee_receivables", nameAr: "مدينون موظفون", defaultCode: "1108" },
  { key: "rep_cash_custody", nameAr: "عُهد المندوبين النقدية", defaultCode: "1105" },
  { key: "payroll_payable", nameAr: "رواتب مستحقة", defaultCode: "2105" },
  { key: "accrued_expenses", nameAr: "مصروفات مستحقة", defaultCode: "2104" },
  { key: "card_clearing", nameAr: "تسوية المدفوعات الإلكترونية", defaultCode: "1102" },
];

/** Idempotently install the template COA; returns code→id map. */
export async function ensureCoa(trx: Trx, tenantId: string): Promise<Map<string, string>> {
  const existing = await trx
    .select({ code: accounts.code, id: accounts.id })
    .from(accounts)
    .where(eq(accounts.tenantId, tenantId));
  const byCode = new Map(existing.map((r) => [r.code, r.id]));
  for (const row of COA_TEMPLATE) {
    if (byCode.has(row.code)) continue;
    const [ins] = await trx
      .insert(accounts)
      .values({
        tenantId,
        code: row.code,
        nameAr: row.nameAr,
        nameEn: row.nameEn ?? null,
        type: row.type,
        parentId: row.parent ? (byCode.get(row.parent) ?? null) : null,
        isGroup: row.group ?? false,
        isControl: row.control ?? false,
      })
      .returning({ id: accounts.id });
    byCode.set(row.code, ins.id);
  }
  return byCode;
}

export async function ensureMappings(trx: Trx, tenantId: string): Promise<void> {
  const byCode = await ensureCoa(trx, tenantId);
  for (const mk of MAPPING_KEYS) {
    const accountId = byCode.get(mk.defaultCode);
    if (!accountId) continue;
    await trx
      .insert(postingMappings)
      .values({ tenantId, key: mk.key, accountId })
      .onConflictDoNothing();
  }
}

/** Remove a mapping (test helper to exercise INV-17 blocking). */
export async function removeMappingForTest(trx: Trx, tenantId: string, key: string): Promise<void> {
  await trx
    .delete(postingMappings)
    .where(and(eq(postingMappings.tenantId, tenantId), eq(postingMappings.key, key)));
}
