/**
 * Permission catalog — single source of truth (SECURITY_AND_TENANCY §4).
 * Codes follow `module.action.scope`. Seeded into `permissions` table by scripts/seed.ts.
 */

export interface PermissionDef {
  code: string;
  module: string;
  nameAr: string;
  nameEn: string;
}

const p = (code: string, module: string, nameAr: string, nameEn: string): PermissionDef => ({
  code,
  module,
  nameAr,
  nameEn,
});

export const PERMISSIONS: readonly PermissionDef[] = [
  // Core
  p("dashboard.view", "core", "عرض لوحة التحكم", "View dashboard"),
  p("notifications.view", "core", "عرض الإشعارات", "View notifications"),

  // Accounting
  p("accounting.journal.view", "accounting", "عرض القيود", "View journals"),
  p("accounting.journal.create", "accounting", "إنشاء قيود", "Create journals"),
  p("accounting.journal.post", "accounting", "ترحيل القيود", "Post journals"),
  p("accounting.journal.approve", "accounting", "اعتماد القيود", "Approve journals"),
  p("accounting.journal.reverse", "accounting", "عكس القيود", "Reverse journals"),
  p("accounting.period.manage", "accounting", "إدارة الفترات المحاسبية", "Manage periods"),
  p("accounting.mappings.manage", "accounting", "إدارة ربط الحسابات", "Manage posting mappings"),
  p("accounting.coa.manage", "accounting", "إدارة شجرة الحسابات", "Manage chart of accounts"),

  // Catalog & parties
  p("catalog.products.view", "catalog", "عرض الأصناف", "View products"),
  p("catalog.products.manage", "catalog", "إدارة الأصناف", "Manage products"),
  p("catalog.prices.manage", "catalog", "إدارة الأسعار وقوائمها", "Manage price lists"),
  p("parties.customers.view", "parties", "عرض العملاء", "View customers"),
  p("parties.customers.manage", "parties", "إدارة العملاء", "Manage customers"),
  p("parties.suppliers.view", "parties", "عرض الموردين", "View suppliers"),
  p("parties.suppliers.manage", "parties", "إدارة الموردين", "Manage suppliers"),

  // Sales
  p("sales.invoice.view", "sales", "عرض فواتير البيع", "View sales invoices"),
  p("sales.invoice.create", "sales", "إنشاء فاتورة بيع", "Create sales invoice"),
  p("sales.invoice.post", "sales", "ترحيل فاتورة بيع", "Post sales invoice"),
  p("sales.return.create", "sales", "إنشاء مردود مبيعات", "Create sales return"),
  p("sales.pos.use", "sales", "استخدام نقطة البيع", "Use POS"),
  p("sales.price.override", "sales", "تجاوز حدود السعر", "Override price boundaries"),
  p("sales.discount.approve", "sales", "اعتماد خصومات", "Approve discounts"),
  p("sales.receipts.manage", "sales", "إدارة سندات القبض", "Manage receipts"),

  // Inventory
  p("inventory.view", "inventory", "عرض المخزون", "View inventory"),
  p("inventory.adjust", "inventory", "تسويات مخزنية", "Stock adjustments"),
  p("inventory.transfer.dispatch", "inventory", "صرف تحويل مخزني", "Dispatch transfers"),
  p("inventory.transfer.receive", "inventory", "استلام تحويل مخزني", "Receive transfers"),
  p("inventory.count.manage", "inventory", "إدارة الجرد", "Manage stock counts"),
  p("inventory.negative.override", "inventory", "السماح بالرصيد السالب", "Allow negative stock"),

  // Purchasing
  p("purchasing.manage", "purchasing", "إدارة المشتريات", "Manage purchasing"),

  // Manufacturing
  p("production.manage", "production", "إدارة أوامر الإنتاج وقوائم المكونات", "Manage production orders & BOMs"),

  // Cash & expenses
  p("cash.manage", "cash", "إدارة الصناديق والبنوك", "Manage cash & banks"),
  p("expenses.create", "cash", "إنشاء مصروف", "Create expense"),
  p("expenses.approve", "cash", "اعتماد المصروفات", "Approve expenses"),

  // Van sales & settlement
  p("vansales.pos.own", "vansales", "نقطة بيع المندوب (خاصة)", "Rep POS (own)"),
  p("vansales.custody.view_own", "vansales", "عرض عهدتي", "View own custody"),
  p("settlement.request.own", "vansales", "طلب تسوية (خاص)", "Request own settlement"),
  p("settlement.review", "vansales", "مراجعة التسويات", "Review settlements"),
  p("settlement.finalize", "vansales", "إقفال التسويات", "Finalize settlements"),
  p("settlement.exception.approve", "vansales", "اعتماد فروقات التسوية", "Approve settlement exceptions"),

  // HR
  p("hr.employees.manage", "hr", "إدارة الموظفين", "Manage employees"),
  p("payroll.manage", "hr", "إدارة الرواتب", "Manage payroll"),

  // Reports
  p("reports.view", "reports", "عرض التقارير", "View reports"),
  p("reports.financial.view", "reports", "عرض القوائم المالية", "View financial statements"),
  p("reports.export", "reports", "تصدير التقارير", "Export reports"),

  // Tax
  p("tax.configure", "tax", "إعداد الضريبة والفوترة الإلكترونية", "Configure tax/e-invoicing"),
  p("tax.view", "tax", "عرض حالة الفوترة الإلكترونية", "View e-invoicing status"),

  // Tenant settings
  p("settings.users.manage", "settings", "إدارة المستخدمين", "Manage users"),
  p("settings.roles.manage", "settings", "إدارة الأدوار والصلاحيات", "Manage roles"),
  p("settings.company.manage", "settings", "إعدادات المنشأة", "Manage company settings"),

  // Platform (console only — granted to platform_users, never tenant roles)
  p("platform.tenants.manage", "platform", "إدارة المستأجرين", "Manage tenants"),
  p("platform.backups.manage", "platform", "إدارة النسخ الاحتياطي", "Manage backups"),
  p("platform.support.grant", "platform", "منح وصول دعم", "Grant support access"),
] as const;

export type PermissionCode = (typeof PERMISSIONS)[number]["code"];

const codes = new Set(PERMISSIONS.map((x) => x.code));
export const isPermissionCode = (v: string): v is PermissionCode => codes.has(v as PermissionCode);

/** Initial tenant role presets (SECURITY_AND_TENANCY §4). Maps role key → permission codes. */
export const ROLE_PRESETS: Record<string, { nameAr: string; nameEn: string; permissions: string[] }> = {
  tenant_owner: {
    nameAr: "مالك المنشأة",
    nameEn: "Tenant Owner",
    permissions: PERMISSIONS.filter((x) => !x.code.startsWith("platform.")).map((x) => x.code),
  },
  accountant: {
    nameAr: "محاسب / مدير النظام",
    nameEn: "Accountant",
    permissions: [
      "dashboard.view", "notifications.view",
      "accounting.journal.view", "accounting.journal.create", "accounting.journal.post",
      "accounting.journal.approve", "accounting.journal.reverse", "accounting.period.manage",
      "accounting.mappings.manage", "accounting.coa.manage",
      "catalog.products.view", "catalog.prices.manage",
      "parties.customers.view", "parties.customers.manage",
      "parties.suppliers.view", "parties.suppliers.manage",
      "sales.invoice.view", "sales.invoice.create", "sales.invoice.post", "sales.return.create",
      "sales.receipts.manage", "sales.discount.approve",
      "inventory.view", "inventory.adjust", "inventory.transfer.dispatch",
      "inventory.transfer.receive", "inventory.count.manage",
      "purchasing.manage", "cash.manage", "expenses.create", "expenses.approve",
      "production.manage",
      "settlement.review", "settlement.finalize", "settlement.exception.approve",
      "reports.view", "reports.financial.view", "reports.export", "tax.view",
      "settings.users.manage", "settings.roles.manage", "settings.company.manage",
    ],
  },
  sales_manager: {
    nameAr: "مدير مبيعات",
    nameEn: "Sales Manager",
    permissions: [
      "dashboard.view", "notifications.view", "catalog.products.view",
      "parties.customers.view", "parties.customers.manage",
      "sales.invoice.view", "sales.invoice.create", "sales.invoice.post", "sales.return.create",
      "sales.pos.use", "sales.price.override", "sales.discount.approve",
      "sales.receipts.manage", "settlement.review", "reports.view", "reports.export",
      "inventory.view",
    ],
  },
  warehouse_manager: {
    nameAr: "أمين المستودع",
    nameEn: "Warehouse Manager",
    permissions: [
      "dashboard.view", "notifications.view", "catalog.products.view",
      "inventory.view", "inventory.adjust", "inventory.transfer.dispatch",
      "inventory.transfer.receive", "inventory.count.manage",
      "purchasing.manage", "reports.view",
    ],
  },
  production_manager: {
    nameAr: "مدير الإنتاج",
    nameEn: "Production Manager",
    permissions: [
      "dashboard.view", "notifications.view", "catalog.products.view",
      "inventory.view", "reports.view", "production.manage",
    ],
  },
  cashier: {
    nameAr: "أمين الصندوق",
    nameEn: "Cashier",
    permissions: [
      "dashboard.view", "notifications.view", "catalog.products.view",
      "parties.customers.view", "sales.invoice.view", "sales.invoice.create",
      "sales.invoice.post", "sales.pos.use", "sales.return.create",
      "sales.receipts.manage", "cash.manage", "expenses.create",
    ],
  },
  field_rep: {
    nameAr: "مندوب مبيعات ميداني",
    nameEn: "Field Sales Rep",
    permissions: [
      "dashboard.view", "notifications.view", "vansales.pos.own",
      "vansales.custody.view_own", "settlement.request.own",
      "parties.customers.view", "catalog.products.view",
    ],
  },
  auditor: {
    nameAr: "مراجع (قراءة فقط)",
    nameEn: "Auditor",
    permissions: [
      "dashboard.view", "notifications.view", "accounting.journal.view",
      "catalog.products.view", "parties.customers.view", "parties.suppliers.view",
      "sales.invoice.view", "inventory.view", "reports.view", "reports.financial.view",
      "tax.view",
    ],
  },
};
