/**
 * Drizzle schema — Phase 1 foundation (DOMAIN_MODEL §2.1).
 * Tenancy & identity, sessions, audit, counters, notifications.
 * IDs are UUIDv7 generated in application code (D-004).
 */

import {
  pgTable,
  uuid,
  text,
  varchar,
  boolean,
  timestamp,
  jsonb,
  bigint,
  numeric,
  uniqueIndex,
  index,
  primaryKey,
  pgEnum,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";

const id = () => uuid("id").primaryKey().$defaultFn(() => uuidv7());

const createdAt = () =>
  timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow();

export const tenantStatus = pgEnum("tenant_status", [
  "trial",
  "active",
  "suspended",
  "deactivated",
]);
export const userStatus = pgEnum("user_status", ["active", "disabled"]);
export const platformRole = pgEnum("platform_role", ["owner", "ops"]);

/* ------------------------------------------------------------------ tenants */
export const tenants = pgTable(
  "tenants",
  {
    id: id(),
    name: varchar("name", { length: 200 }).notNull(),
    nameEn: varchar("name_en", { length: 200 }),
    status: tenantStatus("status").notNull().default("trial"),
    plan: varchar("plan", { length: 50 }).notNull().default("trial"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("tenants_status_idx").on(t.status)],
);

/** Company legal/tax identity + formats — 1:1 with tenant. */
export const companies = pgTable("companies", {
  tenantId: uuid("tenant_id")
    .primaryKey()
    .references(() => tenants.id, { onDelete: "restrict" }),
  legalName: varchar("legal_name", { length: 250 }).notNull(),
  legalNameEn: varchar("legal_name_en", { length: 250 }),
  vatNumber: varchar("vat_number", { length: 30 }),
  crNumber: varchar("cr_number", { length: 30 }),
  baseCurrency: varchar("base_currency", { length: 3 }).notNull().default("SAR"),
  timezone: varchar("timezone", { length: 60 }).notNull().default("Asia/Riyadh"),
  locale: varchar("locale", { length: 10 }).notNull().default("ar"),
  digits: varchar("digits", { length: 10 }).notNull().default("western"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const branches = pgTable(
  "branches",
  {
    id: id(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    code: varchar("code", { length: 30 }).notNull(),
    name: varchar("name", { length: 200 }).notNull(),
    isDefault: boolean("is_default").notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("branches_tenant_code_uq").on(t.tenantId, t.code),
    index("branches_tenant_idx").on(t.tenantId),
  ],
);

/* ------------------------------------------------------------- platform users */
export const platformUsers = pgTable(
  "platform_users",
  {
    id: id(),
    email: varchar("email", { length: 250 }).notNull(),
    passwordHash: text("password_hash").notNull(),
    name: varchar("name", { length: 200 }).notNull(),
    role: platformRole("role").notNull().default("ops"),
    status: userStatus("status").notNull().default("active"),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true, mode: "date" }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("platform_users_email_uq").on(sql`lower(${t.email})`)],
);

/* ---------------------------------------------------------------- tenant users */
export const users = pgTable(
  "users",
  {
    id: id(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    email: varchar("email", { length: 250 }).notNull(),
    passwordHash: text("password_hash").notNull(),
    name: varchar("name", { length: 200 }).notNull(),
    phone: varchar("phone", { length: 40 }),
    status: userStatus("status").notNull().default("active"),
    isOwner: boolean("is_owner").notNull().default(false),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true, mode: "date" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("users_tenant_email_uq").on(t.tenantId, sql`lower(${t.email})`),
    index("users_tenant_idx").on(t.tenantId),
  ],
);

export const employees = pgTable(
  "employees",
  {
    id: id(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    fullName: varchar("full_name", { length: 200 }).notNull(),
    phone: varchar("phone", { length: 40 }),
    jobTitle: varchar("job_title", { length: 120 }),
    status: userStatus("status").notNull().default("active"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("employees_tenant_user_uq").on(t.tenantId, t.userId),
    index("employees_tenant_idx").on(t.tenantId),
  ],
);

/* ------------------------------------------------------------------------ RBAC */
export const permissions = pgTable("permissions", {
  code: varchar("code", { length: 80 }).primaryKey(),
  module: varchar("module", { length: 40 }).notNull(),
  nameAr: varchar("name_ar", { length: 200 }).notNull(),
  nameEn: varchar("name_en", { length: 200 }).notNull(),
});

export const roles = pgTable(
  "roles",
  {
    id: id(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    key: varchar("key", { length: 60 }).notNull(),
    nameAr: varchar("name_ar", { length: 120 }).notNull(),
    nameEn: varchar("name_en", { length: 120 }).notNull(),
    isSystem: boolean("is_system").notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("roles_tenant_key_uq").on(t.tenantId, t.key),
    index("roles_tenant_idx").on(t.tenantId),
  ],
);

export const rolePermissions = pgTable(
  "role_permissions",
  {
    roleId: uuid("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
    permissionCode: varchar("permission_code", { length: 80 })
      .notNull()
      .references(() => permissions.code, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.roleId, t.permissionCode] })],
);

export const userRoles = pgTable(
  "user_roles",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    roleId: uuid("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.roleId] }),
    index("user_roles_tenant_idx").on(t.tenantId),
  ],
);

/* --------------------------------------------------------------------- sessions */
/** Sessions are infrastructure (no RLS) — access only via token hash (SEC §2 note). */
export const sessions = pgTable(
  "sessions",
  {
    id: id(),
    tokenHash: varchar("token_hash", { length: 64 }).notNull(),
    tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    platformUserId: uuid("platform_user_id").references(() => platformUsers.id, {
      onDelete: "cascade",
    }),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true, mode: "date" }),
    ip: varchar("ip", { length: 60 }),
    userAgent: text("user_agent"),
    revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "date" }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("sessions_token_uq").on(t.tokenHash),
    index("sessions_user_idx").on(t.userId),
    index("sessions_expiry_idx").on(t.expiresAt),
  ],
);

/* ------------------------------------------------------------------- audit log */
export const auditLog = pgTable(
  "audit_log",
  {
    id: id(),
    tenantId: uuid("tenant_id"),
    actorUserId: uuid("actor_user_id"),
    actorPlatformUserId: uuid("actor_platform_user_id"),
    actorLabel: varchar("actor_label", { length: 250 }).notNull(),
    action: varchar("action", { length: 120 }).notNull(),
    entity: varchar("entity", { length: 80 }),
    entityId: varchar("entity_id", { length: 80 }),
    before: jsonb("before").$type<unknown>(),
    after: jsonb("after").$type<unknown>(),
    ip: varchar("ip", { length: 60 }),
    userAgent: text("user_agent"),
    at: timestamp("at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    prevHash: varchar("prev_hash", { length: 64 }),
    hash: varchar("hash", { length: 64 }).notNull(),
  },
  (t) => [
    index("audit_tenant_at_idx").on(t.tenantId, t.at),
    index("audit_action_idx").on(t.action),
    index("audit_entity_idx").on(t.entity, t.entityId),
  ],
);

/* ------------------------------------------------------------- doc counters */
export const documentCounters = pgTable(
  "document_counters",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    series: varchar("series", { length: 40 }).notNull(),
    value: bigint("value", { mode: "number" }).notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.series] })],
);

/* --------------------------------------------------------------- notifications */
export const notifications = pgTable(
  "notifications",
  {
    id: id(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: varchar("kind", { length: 60 }).notNull(),
    title: varchar("title", { length: 250 }).notNull(),
    body: text("body"),
    payload: jsonb("payload").$type<Record<string, unknown>>(),
    readAt: timestamp("read_at", { withTimezone: true, mode: "date" }),
    createdAt: createdAt(),
  },
  (t) => [
    index("notifications_user_unread_idx").on(t.userId, t.readAt),
    index("notifications_tenant_idx").on(t.tenantId),
  ],
);

/* ================================================================ Phase 2 */
/* ----------------------------------------------------------- enums (acct/inv) */
export const accountType = pgEnum("account_type", [
  "asset",
  "liability",
  "equity",
  "revenue",
  "expense",
]);
export const journalStatus = pgEnum("journal_status", ["draft", "posted"]);
export const periodStatus = pgEnum("period_status", ["open", "closed"]);
export const warehouseType = pgEnum("warehouse_type", [
  "main",
  "branch",
  "representative_custody",
  "quarantine",
  "in_transit",
]);
export const movementType = pgEnum("movement_type", [
  "receive",
  "issue",
  "transfer_out",
  "transfer_in",
  "adjustment_plus",
  "adjustment_minus",
  "return_in",
  "return_out",
]);
export const transferStatus = pgEnum("transfer_status", [
  "draft",
  "dispatched",
  "partially_received",
  "received",
  "disputed",
  "closed",
  "cancelled",
]);

/* ---------------------------------------------------------------- accounting */
export const accounts = pgTable(
  "accounts",
  {
    id: id(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    code: varchar("code", { length: 20 }).notNull(),
    nameAr: varchar("name_ar", { length: 200 }).notNull(),
    nameEn: varchar("name_en", { length: 200 }),
    type: accountType("type").notNull(),
    parentId: uuid("parent_id"),
    isGroup: boolean("is_group").notNull().default(false),
    isControl: boolean("is_control").notNull().default(false),
    active: boolean("active").notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("accounts_tenant_code_uq").on(t.tenantId, t.code),
    index("accounts_tenant_idx").on(t.tenantId),
  ],
);

/** Required posting accounts per business event (INV-17). */
export const postingMappings = pgTable(
  "posting_mappings",
  {
    id: id(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    key: varchar("key", { length: 60 }).notNull(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "restrict" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("posting_mappings_uq").on(t.tenantId, t.key)],
);

export const fiscalYears = pgTable(
  "fiscal_years",
  {
    id: id(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    name: varchar("name", { length: 20 }).notNull(),
    startDate: varchar("start_date", { length: 10 }).notNull(),
    endDate: varchar("end_date", { length: 10 }).notNull(),
    status: periodStatus("status").notNull().default("open"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("fiscal_years_uq").on(t.tenantId, t.name)],
);

export const fiscalPeriods = pgTable(
  "fiscal_periods",
  {
    id: id(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    yearId: uuid("year_id")
      .notNull()
      .references(() => fiscalYears.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 20 }).notNull(),
    startDate: varchar("start_date", { length: 10 }).notNull(),
    endDate: varchar("end_date", { length: 10 }).notNull(),
    status: periodStatus("status").notNull().default("open"),
    closedAt: timestamp("closed_at", { withTimezone: true, mode: "date" }),
    closedBy: uuid("closed_by"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("fiscal_periods_uq").on(t.tenantId, t.yearId, t.name),
    index("fiscal_periods_dates_idx").on(t.tenantId, t.startDate, t.endDate),
  ],
);

/**
 * Idempotency of posting (INV-02): unique (tenant, source_type, source_id,
 * effect_kind). Official entry number assigned at posting time (D-005).
 */
export const journalEntries = pgTable(
  "journal_entries",
  {
    id: id(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    entryNo: bigint("entry_no", { mode: "number" }),
    status: journalStatus("status").notNull().default("draft"),
    periodId: uuid("period_id").references(() => fiscalPeriods.id, {
      onDelete: "restrict",
    }),
    businessDate: varchar("business_date", { length: 10 }).notNull(),
    memo: text("memo"),
    sourceType: varchar("source_type", { length: 40 }).notNull(),
    sourceId: uuid("source_id").notNull(),
    effectKind: varchar("effect_kind", { length: 40 }).notNull().default("post"),
    reversalOf: uuid("reversal_of"),
    postedAt: timestamp("posted_at", { withTimezone: true, mode: "date" }),
    postedBy: uuid("posted_by"),
    createdBy: uuid("created_by").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("journal_source_uq").on(t.tenantId, t.sourceType, t.sourceId, t.effectKind),
    uniqueIndex("journal_reversal_uq").on(t.tenantId, t.reversalOf),
    uniqueIndex("journal_entry_no_uq").on(t.tenantId, t.entryNo),
    index("journal_tenant_date_idx").on(t.tenantId, t.businessDate),
  ],
);

export const journalLines = pgTable(
  "journal_lines",
  {
    id: id(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    entryId: uuid("entry_id")
      .notNull()
      .references(() => journalEntries.id, { onDelete: "cascade" }),
    lineNo: bigint("line_no", { mode: "number" }).notNull(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "restrict" }),
    debit: numeric("debit", { precision: 19, scale: 4 }).notNull().default("0"),
    credit: numeric("credit", { precision: 19, scale: 4 }).notNull().default("0"),
    branchId: uuid("branch_id"),
    warehouseId: uuid("warehouse_id"),
    representativeId: uuid("representative_id"),
    costCenter: varchar("cost_center", { length: 40 }),
    project: varchar("project", { length: 40 }),
    memo: text("memo"),
  },
  (t) => [index("journal_lines_entry_idx").on(t.entryId), index("journal_lines_account_idx").on(t.tenantId, t.accountId)],
);

/* ------------------------------------------------------------------- catalog */
export const categories = pgTable(
  "categories",
  {
    id: id(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    nameAr: varchar("name_ar", { length: 120 }).notNull(),
    nameEn: varchar("name_en", { length: 120 }),
    parentId: uuid("parent_id"),
  },
  (t) => [index("categories_tenant_idx").on(t.tenantId)],
);

export const brands = pgTable(
  "brands",
  {
    id: id(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    name: varchar("name", { length: 120 }).notNull(),
  },
  (t) => [uniqueIndex("brands_tenant_name_uq").on(t.tenantId, t.name)],
);

export const units = pgTable(
  "units",
  {
    id: id(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    code: varchar("code", { length: 20 }).notNull(),
    nameAr: varchar("name_ar", { length: 80 }).notNull(),
    nameEn: varchar("name_en", { length: 80 }),
  },
  (t) => [uniqueIndex("units_tenant_code_uq").on(t.tenantId, t.code)],
);

export const products = pgTable(
  "products",
  {
    id: id(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    sku: varchar("sku", { length: 40 }).notNull(),
    barcode: varchar("barcode", { length: 60 }),
    nameAr: varchar("name_ar", { length: 200 }).notNull(),
    nameEn: varchar("name_en", { length: 200 }),
    categoryId: uuid("category_id").references(() => categories.id, { onDelete: "set null" }),
    brandId: uuid("brand_id").references(() => brands.id, { onDelete: "set null" }),
    stockUnitId: uuid("stock_unit_id").references(() => units.id, { onDelete: "restrict" }),
    costingMethod: varchar("costing_method", { length: 10 }).notNull().default("wac"),
    trackLots: boolean("track_lots").notNull().default(false),
    trackExpiry: boolean("track_expiry").notNull().default(false),
    taxCategory: varchar("tax_category", { length: 20 }).notNull().default("standard"),
    salePrice: numeric("sale_price", { precision: 19, scale: 4 }).notNull().default("0"),
    minPrice: numeric("min_price", { precision: 19, scale: 4 }),
    maxPrice: numeric("max_price", { precision: 19, scale: 4 }),
    minQty: numeric("min_qty", { precision: 18, scale: 6 }),
    maxQty: numeric("max_qty", { precision: 18, scale: 6 }),
    active: boolean("active").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("products_tenant_sku_uq").on(t.tenantId, t.sku),
    index("products_tenant_idx").on(t.tenantId),
    index("products_barcode_idx").on(t.tenantId, t.barcode),
  ],
);

/** qty_base = qty × factor (D-003 scale 6). */
export const productUnits = pgTable(
  "product_units",
  {
    id: id(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    unitId: uuid("unit_id")
      .notNull()
      .references(() => units.id, { onDelete: "restrict" }),
    factor: numeric("factor", { precision: 18, scale: 6 }).notNull(),
  },
  (t) => [uniqueIndex("product_units_uq").on(t.productId, t.unitId)],
);

/* ----------------------------------------------------------------- inventory */
export const warehouses = pgTable(
  "warehouses",
  {
    id: id(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    code: varchar("code", { length: 30 }).notNull(),
    name: varchar("name", { length: 200 }).notNull(),
    type: warehouseType("type").notNull().default("main"),
    branchId: uuid("branch_id").references(() => branches.id, { onDelete: "set null" }),
    /** For representative_custody warehouses — unique & idempotent (FR-050). */
    representativeUserId: uuid("representative_user_id"),
    allowNegative: boolean("allow_negative").notNull().default(false),
    active: boolean("active").notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("warehouses_tenant_code_uq").on(t.tenantId, t.code),
    uniqueIndex("warehouses_rep_uq").on(t.tenantId, t.representativeUserId),
    index("warehouses_tenant_idx").on(t.tenantId),
  ],
);

export const stockLots = pgTable(
  "stock_lots",
  {
    id: id(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "restrict" }),
    batchNo: varchar("batch_no", { length: 60 }).notNull(),
    expiryDate: varchar("expiry_date", { length: 10 }),
    unitCost: numeric("unit_cost", { precision: 19, scale: 4 }).notNull(),
    qtyOnHand: numeric("qty_on_hand", { precision: 18, scale: 6 }).notNull().default("0"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("stock_lots_uq").on(t.tenantId, t.productId, t.batchNo),
    index("stock_lots_expiry_idx").on(t.tenantId, t.expiryDate),
  ],
);

/**
 * Append-only source of truth for stock (D-008). Signed qty_base (+in / −out).
 * Idempotency: unique (tenant, source_type, source_id, effect_kind, line_ref).
 */
export const stockLedger = pgTable(
  "stock_ledger",
  {
    id: id(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "restrict" }),
    warehouseId: uuid("warehouse_id")
      .notNull()
      .references(() => warehouses.id, { onDelete: "restrict" }),
    lotId: uuid("lot_id").references(() => stockLots.id, { onDelete: "restrict" }),
    movementType: movementType("movement_type").notNull(),
    qtyBase: numeric("qty_base", { precision: 18, scale: 6 }).notNull(),
    unitCost: numeric("unit_cost", { precision: 19, scale: 4 }),
    value: numeric("value", { precision: 19, scale: 4 }),
    sourceType: varchar("source_type", { length: 40 }).notNull(),
    sourceId: uuid("source_id").notNull(),
    effectKind: varchar("effect_kind", { length: 40 }).notNull(),
    lineRef: varchar("line_ref", { length: 80 }).notNull().default(""),
    businessDate: varchar("business_date", { length: 10 }).notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    actorId: uuid("actor_id"),
    memo: text("memo"),
  },
  (t) => [
    uniqueIndex("stock_ledger_source_uq").on(
      t.tenantId, t.sourceType, t.sourceId, t.effectKind, t.lineRef,
    ),
    index("stock_ledger_pw_idx").on(t.tenantId, t.productId, t.warehouseId),
    index("stock_ledger_date_idx").on(t.tenantId, t.businessDate),
  ],
);

/** Materialized balances — reconciled against stock_ledger (INV-06). */
export const stockBalances = pgTable(
  "stock_balances",
  {
    tenantId: uuid("tenant_id").notNull(),
    warehouseId: uuid("warehouse_id").notNull(),
    productId: uuid("product_id").notNull(),
    onHand: numeric("on_hand", { precision: 18, scale: 6 }).notNull().default("0"),
    reserved: numeric("reserved", { precision: 18, scale: 6 }).notNull().default("0"),
    avgCost: numeric("avg_cost", { precision: 19, scale: 4 }).notNull().default("0"),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.warehouseId, t.productId] })],
);

/* ----------------------------------------------------------------- transfers */
export const transfers = pgTable(
  "transfers",
  {
    id: id(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    transferNo: bigint("transfer_no", { mode: "number" }),
    fromWarehouseId: uuid("from_warehouse_id")
      .notNull()
      .references(() => warehouses.id, { onDelete: "restrict" }),
    toWarehouseId: uuid("to_warehouse_id")
      .notNull()
      .references(() => warehouses.id, { onDelete: "restrict" }),
    status: transferStatus("status").notNull().default("draft"),
    businessDate: varchar("business_date", { length: 10 }).notNull(),
    dispatchedAt: timestamp("dispatched_at", { withTimezone: true, mode: "date" }),
    dispatchedBy: uuid("dispatched_by"),
    createdBy: uuid("created_by").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("transfers_no_uq").on(t.tenantId, t.transferNo),
    index("transfers_tenant_idx").on(t.tenantId, t.status),
  ],
);

export const transferLines = pgTable(
  "transfer_lines",
  {
    id: id(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    transferId: uuid("transfer_id")
      .notNull()
      .references(() => transfers.id, { onDelete: "cascade" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "restrict" }),
    lotId: uuid("lot_id").references(() => stockLots.id, { onDelete: "restrict" }),
    qtyDispatched: numeric("qty_dispatched", { precision: 18, scale: 6 }).notNull(),
    qtyReceived: numeric("qty_received", { precision: 18, scale: 6 }).notNull().default("0"),
    discrepancyReason: text("discrepancy_reason"),
  },
  (t) => [index("transfer_lines_transfer_idx").on(t.transferId)],
);

/* ================================================================ Phase 3 */
export const invoiceType = pgEnum("invoice_type", ["sale", "sale_return"]);
export const invoiceStatus = pgEnum("invoice_business_status", ["draft", "posted"]);
export const inventoryDocStatus = pgEnum("inventory_doc_status", [
  "none",
  "issued",
  "partially_returned",
  "returned",
]);
export const accountingDocStatus = pgEnum("accounting_doc_status", [
  "none",
  "posted",
  "reversed",
]);
export const taxDocStatus = pgEnum("tax_doc_status", [
  "not_applicable",
  "local_draft",
  "issued_pending_reporting",
  "reported",
  "clearance_pending",
  "cleared",
  "rejected",
  "failed_retryable",
]);
export const lineKind = pgEnum("line_kind", ["normal", "free", "return_line"]);
export const paymentMethod = pgEnum("payment_method", [
  "cash",
  "bank_transfer",
  "card",
  "other",
]);
export const settlementStatus = pgEnum("settlement_status", ["settled", "pending"]);
export const expenseStatus = pgEnum("expense_status", ["pending", "approved", "rejected"]);

/* ------------------------------------------------------------------- parties */
export const customers = pgTable(
  "customers",
  {
    id: id(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    code: varchar("code", { length: 30 }).notNull(),
    nameAr: varchar("name_ar", { length: 200 }).notNull(),
    nameEn: varchar("name_en", { length: 200 }),
    phone: varchar("phone", { length: 40 }),
    taxNumber: varchar("tax_number", { length: 30 }),
    address: text("address"),
    creditLimit: numeric("credit_limit", { precision: 19, scale: 4 }).notNull().default("0"),
    paymentTermsDays: bigint("payment_terms_days", { mode: "number" }).notNull().default(0),
    creditHold: boolean("credit_hold").notNull().default(false),
    active: boolean("active").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("customers_tenant_code_uq").on(t.tenantId, t.code),
    index("customers_tenant_idx").on(t.tenantId, t.nameAr),
  ],
);

/** Customer-specific effective-dated prices (FR-011). */
export const customerPrices = pgTable(
  "customer_prices",
  {
    id: id(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    price: numeric("price", { precision: 19, scale: 4 }).notNull(),
    effectiveFrom: varchar("effective_from", { length: 10 }).notNull(),
    effectiveTo: varchar("effective_to", { length: 10 }),
  },
  (t) => [uniqueIndex("customer_prices_uq").on(t.tenantId, t.customerId, t.productId)],
);

export const suppliers = pgTable(
  "suppliers",
  {
    id: id(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    code: varchar("code", { length: 30 }).notNull(),
    nameAr: varchar("name_ar", { length: 200 }).notNull(),
    nameEn: varchar("name_en", { length: 200 }),
    phone: varchar("phone", { length: 40 }),
    taxNumber: varchar("tax_number", { length: 30 }),
    paymentTermsDays: bigint("payment_terms_days", { mode: "number" }).notNull().default(0),
    active: boolean("active").notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("suppliers_tenant_code_uq").on(t.tenantId, t.code)],
);

/* ----------------------------------------------------------- sales documents */
/**
 * Four orthogonal status dimensions (DOMAIN_MODEL §4, INV-10/11).
 * Posted invoices are immutable (trigger); returns reference the original doc.
 */
export const salesInvoices = pgTable(
  "sales_invoices",
  {
    id: id(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    invoiceNo: bigint("invoice_no", { mode: "number" }),
    invoiceType: invoiceType("invoice_type").notNull().default("sale"),
    originalInvoiceId: uuid("original_invoice_id"),
    customerId: uuid("customer_id").references(() => customers.id, { onDelete: "restrict" }),
    warehouseId: uuid("warehouse_id")
      .notNull()
      .references(() => warehouses.id, { onDelete: "restrict" }),
    businessDate: varchar("business_date", { length: 10 }).notNull(),
    dueDate: varchar("due_date", { length: 10 }),
    isCredit: boolean("is_credit").notNull().default(false),
    businessStatus: invoiceStatus("business_status").notNull().default("draft"),
    inventoryStatus: inventoryDocStatus("inventory_status").notNull().default("none"),
    accountingStatus: accountingDocStatus("accounting_status").notNull().default("none"),
    taxStatus: taxDocStatus("tax_status").notNull().default("not_applicable"),
    subtotal: numeric("subtotal", { precision: 19, scale: 4 }).notNull().default("0"),
    discountTotal: numeric("discount_total", { precision: 19, scale: 4 }).notNull().default("0"),
    vatTotal: numeric("vat_total", { precision: 19, scale: 4 }).notNull().default("0"),
    total: numeric("total", { precision: 19, scale: 4 }).notNull().default("0"),
    paidTotal: numeric("paid_total", { precision: 19, scale: 4 }).notNull().default("0"),
    salespersonUserId: uuid("salesperson_user_id"),
    /** stable client-generated op id — sync idempotency anchor (D-011). */
    clientOpId: uuid("client_op_id"),
    postedAt: timestamp("posted_at", { withTimezone: true, mode: "date" }),
    postedBy: uuid("posted_by"),
    createdBy: uuid("created_by").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("sales_invoices_no_uq").on(t.tenantId, t.invoiceType, t.invoiceNo),
    uniqueIndex("sales_invoices_clientop_uq").on(t.tenantId, t.clientOpId),
    index("sales_invoices_date_idx").on(t.tenantId, t.businessDate),
    index("sales_invoices_customer_idx").on(t.tenantId, t.customerId),
  ],
);

export const salesInvoiceLines = pgTable(
  "sales_invoice_lines",
  {
    id: id(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    invoiceId: uuid("invoice_id")
      .notNull()
      .references(() => salesInvoices.id, { onDelete: "cascade" }),
    lineNo: bigint("line_no", { mode: "number" }).notNull(),
    lineKind: lineKind("line_kind").notNull().default("normal"),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "restrict" }),
    /** free/return context */
    originalLineId: uuid("original_line_id"),
    qtyBase: numeric("qty_base", { precision: 18, scale: 6 }).notNull(),
    unitPrice: numeric("unit_price", { precision: 19, scale: 4 }).notNull().default("0"),
    originalPrice: numeric("original_price", { precision: 19, scale: 4 }),
    discountAmount: numeric("discount_amount", { precision: 19, scale: 4 }).notNull().default("0"),
    overrideReason: text("override_reason"),
    overrideApprovedBy: uuid("override_approved_by"),
    netAmount: numeric("net_amount", { precision: 19, scale: 4 }).notNull().default("0"),
    vatRate: numeric("vat_rate", { precision: 9, scale: 6 }).notNull().default("0"),
    vatAmount: numeric("vat_amount", { precision: 19, scale: 4 }).notNull().default("0"),
    totalAmount: numeric("total_amount", { precision: 19, scale: 4 }).notNull().default("0"),
    unitCostValue: numeric("unit_cost_value", { precision: 19, scale: 4 }),
    lineCogs: numeric("line_cogs", { precision: 19, scale: 4 }),
  },
  (t) => [index("sales_invoice_lines_invoice_idx").on(t.invoiceId)],
);

/* -------------------------------------------------------- receipts & ledger */
export const receipts = pgTable(
  "receipts",
  {
    id: id(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    receiptNo: bigint("receipt_no", { mode: "number" }),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "restrict" }),
    businessDate: varchar("business_date", { length: 10 }).notNull(),
    totalAmount: numeric("total_amount", { precision: 19, scale: 4 }).notNull(),
    allocatedAmount: numeric("allocated_amount", { precision: 19, scale: 4 }).notNull().default("0"),
    advanceAmount: numeric("advance_amount", { precision: 19, scale: 4 }).notNull().default("0"),
    memo: text("memo"),
    status: varchar("status", { length: 20 }).notNull().default("posted"),
    createdBy: uuid("created_by").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("receipts_no_uq").on(t.tenantId, t.receiptNo),
    index("receipts_customer_idx").on(t.tenantId, t.customerId),
  ],
);

export const receiptLines = pgTable(
  "receipt_lines",
  {
    id: id(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    receiptId: uuid("receipt_id")
      .notNull()
      .references(() => receipts.id, { onDelete: "cascade" }),
    method: paymentMethod("method").notNull(),
    amount: numeric("amount", { precision: 19, scale: 4 }).notNull(),
    treasuryAccountId: uuid("treasury_account_id"),
    reference: varchar("reference", { length: 120 }),
    /** electronic payments settle separately (FR-031 — card ≠ cash). */
    settlementStatus: settlementStatus("settlement_status").notNull().default("settled"),
    settledAt: timestamp("settled_at", { withTimezone: true, mode: "date" }),
  },
  (t) => [index("receipt_lines_receipt_idx").on(t.receiptId)],
);

/**
 * Allocations bind receipts (or advance drawdowns) to invoices (INV-08/09).
 * receipt_id NULL = advance application.
 */
export const allocations = pgTable(
  "allocations",
  {
    id: id(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    receiptId: uuid("receipt_id"),
    invoiceId: uuid("invoice_id")
      .notNull()
      .references(() => salesInvoices.id, { onDelete: "restrict" }),
    amount: numeric("amount", { precision: 19, scale: 4 }).notNull(),
    isAdvanceApplication: boolean("is_advance_application").notNull().default(false),
    createdBy: uuid("created_by").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("allocations_invoice_idx").on(t.tenantId, t.invoiceId)],
);

/* ----------------------------------------------------------------- treasury */
export const treasuryAccounts = pgTable(
  "treasury_accounts",
  {
    id: id(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    code: varchar("code", { length: 30 }).notNull(),
    name: varchar("name", { length: 120 }).notNull(),
    kind: varchar("kind", { length: 10 }).notNull().default("cash"), // cash | bank
    active: boolean("active").notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("treasury_tenant_code_uq").on(t.tenantId, t.code)],
);

export const expenses = pgTable(
  "expenses",
  {
    id: id(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    expenseNo: bigint("expense_no", { mode: "number" }),
    category: varchar("category", { length: 80 }).notNull(),
    amount: numeric("amount", { precision: 19, scale: 4 }).notNull(),
    method: paymentMethod("method").notNull().default("cash"),
    treasuryAccountId: uuid("treasury_account_id")
      .notNull()
      .references(() => treasuryAccounts.id, { onDelete: "restrict" }),
    businessDate: varchar("business_date", { length: 10 }).notNull(),
    note: text("note"),
    status: expenseStatus("status").notNull().default("pending"),
    approvedBy: uuid("approved_by"),
    approvedAt: timestamp("approved_at", { withTimezone: true, mode: "date" }),
    journalEntryId: uuid("journal_entry_id"),
    createdBy: uuid("created_by").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("expenses_no_uq").on(t.tenantId, t.expenseNo)],
);

/* ---------------------------------------------------------------- purchases */
export const purchaseInvoices = pgTable(
  "purchase_invoices",
  {
    id: id(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    invoiceNo: bigint("invoice_no", { mode: "number" }),
    supplierId: uuid("supplier_id")
      .notNull()
      .references(() => suppliers.id, { onDelete: "restrict" }),
    supplierRef: varchar("supplier_ref", { length: 60 }),
    warehouseId: uuid("warehouse_id")
      .notNull()
      .references(() => warehouses.id, { onDelete: "restrict" }),
    businessDate: varchar("business_date", { length: 10 }).notNull(),
    dueDate: varchar("due_date", { length: 10 }),
    isReturn: boolean("is_return").notNull().default(false),
    originalInvoiceId: uuid("original_invoice_id"),
    status: invoiceStatus("status").notNull().default("draft"),
    subtotal: numeric("subtotal", { precision: 19, scale: 4 }).notNull().default("0"),
    vatTotal: numeric("vat_total", { precision: 19, scale: 4 }).notNull().default("0"),
    total: numeric("total", { precision: 19, scale: 4 }).notNull().default("0"),
    paidTotal: numeric("paid_total", { precision: 19, scale: 4 }).notNull().default("0"),
    postedAt: timestamp("posted_at", { withTimezone: true, mode: "date" }),
    createdBy: uuid("created_by").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("purchase_invoices_no_uq").on(t.tenantId, t.invoiceNo),
    index("purchase_invoices_supplier_idx").on(t.tenantId, t.supplierId),
  ],
);

export const purchaseInvoiceLines = pgTable(
  "purchase_invoice_lines",
  {
    id: id(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    invoiceId: uuid("invoice_id")
      .notNull()
      .references(() => purchaseInvoices.id, { onDelete: "cascade" }),
    lineNo: bigint("line_no", { mode: "number" }).notNull(),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "restrict" }),
    qtyBase: numeric("qty_base", { precision: 18, scale: 6 }).notNull(),
    unitCost: numeric("unit_cost", { precision: 19, scale: 4 }).notNull(),
    netAmount: numeric("net_amount", { precision: 19, scale: 4 }).notNull(),
    vatRate: numeric("vat_rate", { precision: 9, scale: 6 }).notNull().default("0"),
    vatAmount: numeric("vat_amount", { precision: 19, scale: 4 }).notNull().default("0"),
    batchNo: varchar("batch_no", { length: 60 }),
    expiryDate: varchar("expiry_date", { length: 10 }),
  },
  (t) => [index("purchase_invoice_lines_invoice_idx").on(t.invoiceId)],
);

export const supplierPayments = pgTable(
  "supplier_payments",
  {
    id: id(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    paymentNo: bigint("payment_no", { mode: "number" }),
    supplierId: uuid("supplier_id")
      .notNull()
      .references(() => suppliers.id, { onDelete: "restrict" }),
    businessDate: varchar("business_date", { length: 10 }).notNull(),
    method: paymentMethod("method").notNull().default("cash"),
    treasuryAccountId: uuid("treasury_account_id")
      .notNull()
      .references(() => treasuryAccounts.id, { onDelete: "restrict" }),
    amount: numeric("amount", { precision: 19, scale: 4 }).notNull(),
    allocatedAmount: numeric("allocated_amount", { precision: 19, scale: 4 }).notNull().default("0"),
    memo: text("memo"),
    status: varchar("status", { length: 20 }).notNull().default("posted"),
    createdBy: uuid("created_by").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("supplier_payments_no_uq").on(t.tenantId, t.paymentNo)],
);

export const supplierAllocations = pgTable(
  "supplier_allocations",
  {
    id: id(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    paymentId: uuid("payment_id")
      .notNull()
      .references(() => supplierPayments.id, { onDelete: "cascade" }),
    purchaseInvoiceId: uuid("purchase_invoice_id")
      .notNull()
      .references(() => purchaseInvoices.id, { onDelete: "restrict" }),
    amount: numeric("amount", { precision: 19, scale: 4 }).notNull(),
    createdBy: uuid("created_by").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("supplier_alloc_invoice_idx").on(t.tenantId, t.purchaseInvoiceId)],
);

/* ================================================================ Phase 4 */
export const deviceStatus = pgEnum("device_status", ["active", "revoked"]);
export const settlementStatusFlow = pgEnum("settlement_status_flow", [
  "requested",
  "under_review",
  "closed",
]);
export const exceptionResolution = pgEnum("exception_resolution", [
  "pending",
  "approved_adjustment",
  "escalated",
]);

/* ---------------------------------------------------------------- van sales */
/** 1:1 employee↔user; custody warehouse idempotent per representative (FR-050). */
export const representatives = pgTable(
  "representatives",
  {
    id: id(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    employeeId: uuid("employee_id")
      .notNull()
      .references(() => employees.id, { onDelete: "restrict" }),
    custodyWarehouseId: uuid("custody_warehouse_id"),
    active: boolean("active").notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("representatives_user_uq").on(t.tenantId, t.userId),
    uniqueIndex("representatives_employee_uq").on(t.tenantId, t.employeeId),
  ],
);

export const devices = pgTable(
  "devices",
  {
    id: uuid("id").primaryKey(), // client-generated device uuid
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    label: varchar("label", { length: 120 }).notNull(),
    platform: varchar("platform", { length: 60 }),
    status: deviceStatus("status").notNull().default("active"),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true, mode: "date" }),
    createdAt: createdAt(),
  },
  (t) => [index("devices_user_idx").on(t.tenantId, t.userId)],
);

/** Server-side sync dedupe + tamper evidence (INV-02/05, OFFLINE_SYNC §4). */
export const idempotencyKeys = pgTable(
  "idempotency_keys",
  {
    tenantId: uuid("tenant_id").notNull(),
    deviceId: uuid("device_id").notNull(),
    opId: uuid("op_id").notNull(),
    opType: varchar("op_type", { length: 60 }).notNull(),
    payloadHash: varchar("payload_hash", { length: 64 }).notNull(),
    status: varchar("status", { length: 20 }).notNull(), // ack | rejected | conflict | tamper
    result: jsonb("result").$type<Record<string, unknown>>(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.deviceId, t.opId] })],
);

export const syncCursors = pgTable(
  "sync_cursors",
  {
    tenantId: uuid("tenant_id").notNull(),
    deviceId: uuid("device_id").notNull(),
    scope: varchar("scope", { length: 40 }).notNull(),
    cursor: text("cursor").notNull().default("1970-01-01T00:00:00.000Z"),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.deviceId, t.scope] })],
);

/* ---------------------------------------------------------------- settlement */
export const settlements = pgTable(
  "settlements",
  {
    id: id(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    settlementNo: bigint("settlement_no", { mode: "number" }),
    repUserId: uuid("rep_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    custodyWarehouseId: uuid("custody_warehouse_id")
      .notNull()
      .references(() => warehouses.id, { onDelete: "restrict" }),
    businessDate: varchar("business_date", { length: 10 }).notNull(),
    status: settlementStatusFlow("status").notNull().default("requested"),
    expectedCash: numeric("expected_cash", { precision: 19, scale: 4 }),
    countedCash: numeric("counted_cash", { precision: 19, scale: 4 }),
    snapshot: jsonb("snapshot").$type<Record<string, unknown>>(),
    reviewedBy: uuid("reviewed_by"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true, mode: "date" }),
    closedBy: uuid("closed_by"),
    closedAt: timestamp("closed_at", { withTimezone: true, mode: "date" }),
    createdBy: uuid("created_by").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("settlements_no_uq").on(t.tenantId, t.settlementNo),
    index("settlements_rep_idx").on(t.tenantId, t.repUserId, t.status),
  ],
);

/** Expected-vs-counted stock lines, computed from authoritative ledger data. */
export const settlementLines = pgTable(
  "settlement_lines",
  {
    id: id(),
    tenantId: uuid("tenant_id").notNull(),
    settlementId: uuid("settlement_id")
      .notNull()
      .references(() => settlements.id, { onDelete: "cascade" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "restrict" }),
    expectedQty: numeric("expected_qty", { precision: 18, scale: 6 }).notNull(),
    countedQty: numeric("counted_qty", { precision: 18, scale: 6 }),
    diffQty: numeric("diff_qty", { precision: 18, scale: 6 }),
  },
  (t) => [index("settlement_lines_idx").on(t.settlementId)],
);

/** Discrepancies are ALWAYS exception-first (D-022): never auto-debt. */
export const settlementExceptions = pgTable(
  "settlement_exceptions",
  {
    id: id(),
    tenantId: uuid("tenant_id").notNull(),
    settlementId: uuid("settlement_id")
      .notNull()
      .references(() => settlements.id, { onDelete: "cascade" }),
    kind: varchar("kind", { length: 30 }).notNull(), // shortage | overage | info
    entity: varchar("entity", { length: 30 }).notNull(), // stock | cash | epayment | sync
    productId: uuid("product_id").references(() => products.id, { onDelete: "restrict" }),
    expected: numeric("expected", { precision: 19, scale: 6 }),
    actual: numeric("actual", { precision: 19, scale: 6 }),
    diff: numeric("diff", { precision: 19, scale: 6 }),
    note: text("note"),
    resolution: exceptionResolution("resolution").notNull().default("pending"),
    journalEntryId: uuid("journal_entry_id"),
    approvedBy: uuid("approved_by"),
    approvedAt: timestamp("approved_at", { withTimezone: true, mode: "date" }),
    createdBy: uuid("created_by").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("settlement_exceptions_idx").on(t.settlementId)],
);

/* ================================================================ Phase 5 */
export const productionStatus = pgEnum("production_status", [
  "planned",
  "in_progress",
  "completed",
  "cancelled",
]);

/* ------------------------------------------------------------- manufacturing */
/** Versioned recipe (BOM). Editing creates a new version; posted versions stay. */
export const boms = pgTable(
  "boms",
  {
    id: id(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "restrict" }),
    version: bigint("version", { mode: "number" }).notNull().default(1),
    name: varchar("name", { length: 160 }).notNull(),
    /** finished goods quantity produced per batch */
    yieldQty: numeric("yield_qty", { precision: 18, scale: 6 }).notNull(),
    active: boolean("active").notNull().default(true),
    notes: text("notes"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("boms_product_version_uq").on(t.tenantId, t.productId, t.version)],
);

export const bomLines = pgTable(
  "bom_lines",
  {
    id: id(),
    tenantId: uuid("tenant_id").notNull(),
    bomId: uuid("bom_id")
      .notNull()
      .references(() => boms.id, { onDelete: "cascade" }),
    lineNo: bigint("line_no", { mode: "number" }).notNull(),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "restrict" }),
    qty: numeric("qty", { precision: 18, scale: 6 }).notNull(),
  },
  (t) => [index("bom_lines_bom_idx").on(t.bomId)],
);

export const productionOrders = pgTable(
  "production_orders",
  {
    id: id(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    orderNo: bigint("order_no", { mode: "number" }),
    bomId: uuid("bom_id")
      .notNull()
      .references(() => boms.id, { onDelete: "restrict" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "restrict" }),
    plannedQty: numeric("planned_qty", { precision: 18, scale: 6 }).notNull(),
    outputQty: numeric("output_qty", { precision: 18, scale: 6 }),
    fromWarehouseId: uuid("from_warehouse_id")
      .notNull()
      .references(() => warehouses.id, { onDelete: "restrict" }),
    toWarehouseId: uuid("to_warehouse_id")
      .notNull()
      .references(() => warehouses.id, { onDelete: "restrict" }),
    status: productionStatus("status").notNull().default("planned"),
    businessDate: varchar("business_date", { length: 10 }).notNull(),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "date" }),
    completedAt: timestamp("completed_at", { withTimezone: true, mode: "date" }),
    createdBy: uuid("created_by").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("production_orders_no_uq").on(t.tenantId, t.orderNo),
    index("production_orders_status_idx").on(t.tenantId, t.status),
  ],
);

/** Planned vs actual material consumption with actual lot-derived cost. */
export const productionConsumptions = pgTable(
  "production_consumptions",
  {
    id: id(),
    tenantId: uuid("tenant_id").notNull(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => productionOrders.id, { onDelete: "cascade" }),
    bomLineId: uuid("bom_line_id"),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "restrict" }),
    plannedQty: numeric("planned_qty", { precision: 18, scale: 6 }).notNull(),
    actualQty: numeric("actual_qty", { precision: 18, scale: 6 }).notNull(),
    costValue: numeric("cost_value", { precision: 19, scale: 4 }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("production_consumptions_order_idx").on(t.orderId)],
);

export const productionOutputs = pgTable(
  "production_outputs",
  {
    id: id(),
    tenantId: uuid("tenant_id").notNull(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => productionOrders.id, { onDelete: "cascade" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "restrict" }),
    qty: numeric("qty", { precision: 18, scale: 6 }).notNull(),
    unitCost: numeric("unit_cost", { precision: 19, scale: 4 }).notNull(),
    lotId: uuid("lot_id"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("production_outputs_order_uq").on(t.orderId)],
);

/** Labor / overhead / other production cost components (P-19). */
export const productionCostComponents = pgTable(
  "production_cost_components",
  {
    id: id(),
    tenantId: uuid("tenant_id").notNull(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => productionOrders.id, { onDelete: "cascade" }),
    kind: varchar("kind", { length: 20 }).notNull(), // labor | overhead | other
    description: varchar("description", { length: 200 }),
    amount: numeric("amount", { precision: 19, scale: 4 }).notNull(),
    journalEntryId: uuid("journal_entry_id"),
    createdAt: createdAt(),
  },
  (t) => [index("production_components_order_idx").on(t.orderId)],
);

/* ================================================================ Phase 6 */
export const zatcaEnvironment = pgEnum("zatca_environment", [
  "developer-portal",
  "simulation",
  "core",
]);
export const submissionStatusFlow = pgEnum("submission_status_flow", [
  "draft_local",
  "issued_pending_reporting",
  "clearance_pending",
  "reported",
  "cleared",
  "rejected",
  "failed_retryable",
  "blocked_config",
]);

/* --------------------------------------------------------------- tax module */
/** Seller tax identity & compliance policy flags per tenant. */
export const taxConfigs = pgTable("tax_configs", {
  tenantId: uuid("tenant_id")
    .primaryKey()
    .references(() => tenants.id, { onDelete: "restrict" }),
  enabled: boolean("enabled").notNull().default(false),
  env: zatcaEnvironment("env").notNull().default("developer-portal"),
  /** seller address (required by UBL) */
  street: varchar("street", { length: 200 }),
  district: varchar("district", { length: 120 }),
  city: varchar("city", { length: 120 }),
  postalCode: varchar("postal_code", { length: 10 }),
  buildingNo: varchar("building_no", { length: 10 }),
  industry: varchar("industry", { length: 120 }),
  /** free-goods VAT policy flag (D-021/OQ-4) */
  freeGoodsDeemedSupply: boolean("free_goods_deemed_supply").notNull().default(false),
  onboardingState: varchar("onboarding_state", { length: 40 }).notNull().default("none"), // none | compliance | production
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** EGS certificate material (private key encrypted at rest, token+secret). */
export const zatcaCertificates = pgTable(
  "zatca_certificates",
  {
    id: id(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    env: zatcaEnvironment("env").notNull(),
    kind: varchar("kind", { length: 20 }).notNull(), // device_key | compliance | production
    label: varchar("label", { length: 120 }),
    /** PEM/JWK private key (device) — encrypted field-level at rest (D-024) */
    privateKey: text("private_key"),
    publicKey: text("public_key"),
    binarySecurityToken: text("binary_security_token"),
    secret: text("secret"),
    requestId: varchar("request_id", { length: 120 }),
    status: varchar("status", { length: 20 }).notNull().default("active"),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }),
    createdAt: createdAt(),
  },
  (t) => [index("zatca_certs_tenant_idx").on(t.tenantId, t.env, t.kind)],
);

/**
 * Per-EGS invoice chain state: ICV (monotonic per chain) + PIH linkage.
 * Row locked at issuance (posting transaction) so ICV is gapless per chain.
 */
export const invoiceChains = pgTable(
  "invoice_chains",
  {
    id: varchar("id", { length: 80 }).primaryKey(), // `${tenantId}:main`
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    icv: bigint("icv", { mode: "number" }).notNull().default(0),
    lastHash: varchar("last_hash", { length: 96 }).notNull().default(
      "NWZlY2ViNjIzNGRjMjc5OWJkOTU5M2NlMWZkM2Q2MjQxMjBiNTQ4NjE5YmY0Mzk3ZTk2NjcyZDUxMGE2NGE1Mg==",
    ),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("invoice_chains_tenant_idx").on(t.tenantId)],
);

/** E-invoice submissions with full status history (never fabricated success). */
export const invoiceSubmissions = pgTable(
  "invoice_submissions",
  {
    id: id(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    invoiceId: uuid("invoice_id")
      .notNull()
      .references(() => salesInvoices.id, { onDelete: "restrict" }),
    invoiceUuid: uuid("invoice_uuid").notNull(),
    icv: bigint("icv", { mode: "number" }).notNull(),
    docType: varchar("doc_type", { length: 20 }).notNull(), // simplified | standard
    docSubtype: varchar("doc_subtype", { length: 20 }).notNull().default("invoice"), // invoice | credit_note
    previousHash: varchar("previous_hash", { length: 96 }).notNull(),
    invoiceHash: varchar("invoice_hash", { length: 96 }).notNull(),
    xml: text("xml").notNull(),
    qrBase64: text("qr_base64"),
    signatureValue: text("signature_value"),
    status: submissionStatusFlow("status").notNull(),
    attempts: bigint("attempts", { mode: "number" }).notNull().default(0),
    lastErrorClass: varchar("last_error_class", { length: 40 }),
    lastError: text("last_error"),
    submittedAt: timestamp("submitted_at", { withTimezone: true, mode: "date" }),
    acceptedAt: timestamp("accepted_at", { withTimezone: true, mode: "date" }),
    response: jsonb("response").$type<Record<string, unknown>>(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("invoice_submissions_invoice_uq").on(t.invoiceId),
    uniqueIndex("invoice_submissions_uuid_uq").on(t.tenantId, t.invoiceUuid),
    index("invoice_submissions_status_idx").on(t.tenantId, t.status),
  ],
);

export const schema = {
  tenants,
  companies,
  branches,
  platformUsers,
  users,
  employees,
  permissions,
  roles,
  rolePermissions,
  userRoles,
  sessions,
  auditLog,
  documentCounters,
  notifications,
  // phase 2 — accounting
  accounts,
  postingMappings,
  fiscalYears,
  fiscalPeriods,
  journalEntries,
  journalLines,
  // phase 2 — catalog
  categories,
  brands,
  units,
  products,
  productUnits,
  // phase 2 — inventory & transfers
  warehouses,
  stockLots,
  stockLedger,
  stockBalances,
  transfers,
  transferLines,
  // phase 3 — parties, sales, receipts, treasury, purchases
  customers,
  customerPrices,
  suppliers,
  salesInvoices,
  salesInvoiceLines,
  receipts,
  receiptLines,
  allocations,
  treasuryAccounts,
  expenses,
  purchaseInvoices,
  purchaseInvoiceLines,
  supplierPayments,
  supplierAllocations,
  // phase 4 — van sales & settlement
  representatives,
  devices,
  idempotencyKeys,
  syncCursors,
  settlements,
  settlementLines,
  settlementExceptions,
  // phase 5 — manufacturing
  boms,
  bomLines,
  productionOrders,
  productionConsumptions,
  productionOutputs,
  productionCostComponents,
  // phase 6 — tax / e-invoicing
  taxConfigs,
  zatcaCertificates,
  invoiceChains,
  invoiceSubmissions,
  // enums
  tenantStatus,
  userStatus,
  platformRole,
  accountType,
  journalStatus,
  periodStatus,
  warehouseType,
  movementType,
  transferStatus,
  invoiceType,
  invoiceStatus,
  inventoryDocStatus,
  accountingDocStatus,
  taxDocStatus,
  lineKind,
  paymentMethod,
  settlementStatus,
  expenseStatus,
  deviceStatus,
  settlementStatusFlow,
  exceptionResolution,
  productionStatus,
  zatcaEnvironment,
  submissionStatusFlow,
};
