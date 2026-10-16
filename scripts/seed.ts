/**
 * Idempotent sandbox seed (Phase 1 exit criterion).
 * Creates: permission catalog, platform owner, two demo tenants (A/B) with
 * companies, branches, preset roles + permissions, and demo users.
 *
 *   run: npx tsx scripts/seed.ts
 *
 * Passwords come from SEED_BOOTSTRAP_PASSWORD / SEED_DEMO_PASSWORD env,
 * defaulting to the documented sandbox password "Hisab#2026" (sandbox only,
 * never production — see docs/PROGRESS.md).
 */

import "dotenv/config";
import { eq, and, sql } from "drizzle-orm";
import { db } from "@/db";
import {
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
  notifications,
  warehouses,
  units as unitTable,
  categories,
  brands,
  products,
  productUnits,
  journalEntries,
} from "@/db/schema";
import { PERMISSIONS, ROLE_PRESETS } from "@/modules/shared/permissions";
import { hashPassword } from "@/modules/identity/auth";
import { writeAudit } from "@/modules/shared/audit";
import { bindTenant, type Trx } from "@/modules/shared/db-context";
import { ensureCoa, ensureMappings } from "@/modules/accounting/coa";
import { ensureFiscalYear } from "@/modules/accounting/periods";
import { resolveMappingId } from "@/modules/accounting/mappings";
import { postEntry } from "@/modules/accounting/posting";
import { recordMovement } from "@/modules/inventory/stock";
import { Decimal } from "@/modules/shared/money";
import { newId } from "@/modules/shared/ids";
import { customers, customerPrices, suppliers, treasuryAccounts } from "@/db/schema";

const DEMO_PASSWORD = process.env.SEED_DEMO_PASSWORD ?? "Hisab#2026";
const BOOTSTRAP_PASSWORD = process.env.SEED_BOOTSTRAP_PASSWORD ?? "Hisab#2026";

async function ensurePermissionCatalog() {
  let added = 0;
  for (const p of PERMISSIONS) {
    const [exists] = await db.select({ code: permissions.code }).from(permissions).where(eq(permissions.code, p.code)).limit(1);
    if (!exists) {
      await db.insert(permissions).values(p);
      added++;
    }
  }
  return added;
}

/**
 * Platform codes were briefly seeded into the tenant permission catalog; a role
 * carrying them must never exist again (PLATFORM_ADMIN §1: platform authority is
 * not a tenant permission). Both the stale grants and the catalog rows go.
 */
async function revokePlatformGrantedPermissions() {
  const grants = (await db.execute(sql`
    delete from role_permissions rp
     using permissions p
     where p.code = rp.permission_code and p.code like 'platform.%'
    returning 1`)) as unknown as { rows: unknown[] };
  const stale = (await db.execute(sql`
    delete from permissions where code like 'platform.%' returning 1`)) as unknown as { rows: unknown[] };
  return { grants: grants.rows.length, stale: stale.rows.length };
}

async function ensurePlatformOwner() {
  const email = (process.env.SEED_PLATFORM_EMAIL ?? "admin@hisab.sa").toLowerCase();
  const found = await db.execute(sql`select * from public.platform_login_lookup(${email})`);
  const rows = (found as unknown as { rows: unknown[] }).rows as { platform_user_id: string }[];
  if (rows.length > 0) {
    // Same rule as the demo users: `db:seed` is the sandbox bootstrap, and an operator who runs
    // it must be able to sign in with the password the seed just printed. Without this, a
    // password that was created while `.env` held a truncated value (a `#` in the password, see
    // `npm run env:check`) stayed wrong forever and the console was unreachable.
    await db
      .update(platformUsers)
      .set({ passwordHash: await hashPassword(BOOTSTRAP_PASSWORD) })
      .where(eq(platformUsers.id, rows[0]!.platform_user_id));
    return { email, created: false, passwordRefreshed: true };
  }
  await db.insert(platformUsers).values({
    email,
    passwordHash: await hashPassword(BOOTSTRAP_PASSWORD),
    name: "مالك المنصة",
    role: "owner",
  });
  await writeAudit(db, {
    tenantId: null,
    actorPlatformUserId: null,
    actorLabel: "system/seed",
    action: "seed.platform_owner.created",
    entity: "platform_user",
    entityId: email,
  });
  return { email, created: true, passwordRefreshed: false };
}

interface TenantSeed {
  name: string;
  nameEn: string;
  legalName: string;
  vatNumber: string;
  branchName: string;
  users: { email: string; name: string; roleKey: string; job?: string; phone?: string }[];
}

async function ensureTenant(seed: TenantSeed) {
  let [tenant] = await db.select().from(tenants).where(eq(tenants.name, seed.name)).limit(1);
  if (!tenant) {
    [tenant] = await db.insert(tenants).values({ name: seed.name, nameEn: seed.nameEn, status: "active", plan: "pro" }).returning();
  }

  const [company] = await db.select().from(companies).where(eq(companies.tenantId, tenant.id)).limit(1);
  if (!company) {
    await db.insert(companies).values({
      tenantId: tenant.id,
      legalName: seed.legalName,
      vatNumber: seed.vatNumber,
    });
  }

  const [branch] = await db.select().from(branches).where(and(eq(branches.tenantId, tenant.id), eq(branches.code, "HQ"))).limit(1);
  if (!branch) {
    await db.insert(branches).values({ tenantId: tenant.id, code: "HQ", name: seed.branchName, isDefault: true });
  }

  // preset roles + their permission maps
  const roleIds: Record<string, string> = {};
  for (const [key, preset] of Object.entries(ROLE_PRESETS)) {
    let [role] = await db.select().from(roles).where(and(eq(roles.tenantId, tenant.id), eq(roles.key, key))).limit(1);
    if (!role) {
      [role] = await db.insert(roles).values({
        tenantId: tenant.id,
        key,
        nameAr: preset.nameAr,
        nameEn: preset.nameEn,
        isSystem: true,
      }).returning();
    }
    roleIds[key] = role.id;
    for (const code of preset.permissions) {
      await db
        .insert(rolePermissions)
        .values({ roleId: role.id, permissionCode: code })
        .onConflictDoNothing();
    }
  }

  // demo users
  const created: string[] = [];
  for (const u of seed.users) {
    const email = u.email.toLowerCase();
    const [existing] = await db
      .select()
      .from(users)
      .where(and(eq(users.tenantId, tenant.id), sql`lower(${users.email}) = ${email}`))
      .limit(1);
    let userId: string;
    if (existing) {
      userId = existing.id;
      // `db:seed` is advertised as idempotent, and a printed sign-in line that no longer
      // works is worse than no line at all: the password in the environment (which may have
      // changed since the row was created — or have been truncated by a `#` in .env) is
      // re-applied here, so "run seed again" always restores a working demo login.
      await db
        .update(users)
        .set({ passwordHash: await hashPassword(DEMO_PASSWORD) })
        .where(eq(users.id, userId));
      created.push(`${email} (password refreshed)`);
    } else {
      const [createdUser] = await db.insert(users).values({
        tenantId: tenant.id,
        email,
        passwordHash: await hashPassword(DEMO_PASSWORD),
        name: u.name,
        phone: u.phone ?? null,
        isOwner: u.roleKey === "tenant_owner",
      }).returning();
      userId = createdUser.id;
      created.push(email);
      await writeAudit(db, {
        tenantId: tenant.id,
        actorUserId: null,
        actorLabel: "system/seed",
        action: "seed.user.created",
        entity: "user",
        entityId: userId,
        after: { email, role: u.roleKey },
      });
    }
    const roleId = roleIds[u.roleKey];
    if (roleId) {
      await db.insert(userRoles).values({ tenantId: tenant.id, userId, roleId }).onConflictDoNothing();
    }
    await db
      .insert(employees)
      .values({ tenantId: tenant.id, userId, fullName: u.name, jobTitle: u.job ?? u.roleKey, phone: u.phone ?? null })
      .onConflictDoNothing();
  }

  // welcome notification for the owner (once)
  const [ownerUser] = await db
    .select()
    .from(users)
    .where(and(eq(users.tenantId, tenant.id), eq(users.isOwner, true)))
    .limit(1);
  if (ownerUser) {
    const [existingNotif] = await db
      .select({ id: notifications.id })
      .from(notifications)
      .where(and(eq(notifications.userId, ownerUser.id), eq(notifications.kind, "system.welcome")))
      .limit(1);
    if (!existingNotif) {
      await db.insert(notifications).values({
        tenantId: tenant.id,
        userId: ownerUser.id,
        kind: "system.welcome",
        title: "أهلاً بك في حِساب",
        body: "اكتمل تجهيز منشأتك: الهوية والصلاحيات وسجل التدقيق جاهزة.",
        payload: { phase: 1 },
      });
    }
  }

  return { tenant, createdUsers: created };
}

/* ============================ Phase 2 seed ================================= */

interface ProductSeed {
  sku: string;
  barcode: string;
  nameAr: string;
  nameEn?: string;
  category: string;
  unit: string;
  trackLots?: boolean;
  trackExpiry?: boolean;
  salePrice: string;
  minPrice?: string;
  maxPrice?: string;
  opening?: { qty: string; cost: string; batchNo?: string; expiry?: string };
  ctnFactor?: string;
}

const CATALOG_UNITS = [
  { code: "EA", nameAr: "قطعة", nameEn: "Piece" },
  { code: "CTN", nameAr: "كرتونة", nameEn: "Carton" },
  { code: "KG", nameAr: "كيلوغرام", nameEn: "Kilogram" },
  { code: "LTR", nameAr: "لتر", nameEn: "Liter" },
];

const PRODUCT_SEEDS: ProductSeed[] = [
  { sku: "RM-FLOUR-25", barcode: "6281000000011", nameAr: "دقيق قمح ٢٥ كجم", nameEn: "Wheat flour 25kg", category: "مواد خام", unit: "KG", trackLots: true, trackExpiry: true, salePrice: "0", opening: { qty: "200", cost: "8.50", batchNo: "B-FLOUR-2601", expiry: "2027-01-01" } },
  { sku: "RM-SUGAR-10", barcode: "6281000000028", nameAr: "سكر ١٠ كجم", nameEn: "Sugar 10kg", category: "مواد خام", unit: "KG", trackLots: true, trackExpiry: true, salePrice: "0", opening: { qty: "150", cost: "11.00", batchNo: "B-SUGAR-2601", expiry: "2026-09-30" } },
  { sku: "FG-JUICE-OR1", barcode: "6281000000035", nameAr: "عصير برتقال ١ لتر (كرتونة ١٢)", nameEn: "Orange juice 1L", category: "منتجات تامة", unit: "EA", trackLots: true, trackExpiry: true, salePrice: "6.50", minPrice: "5.50", maxPrice: "8.00", ctnFactor: "12", opening: { qty: "300", cost: "4.75", batchNo: "B-JUICE-2603", expiry: "2026-12-31" } },
  { sku: "FG-DATES-500", barcode: "6281000000042", nameAr: "تمر فاخر ٥٠٠ غ", nameEn: "Premium dates 500g", category: "منتجات تامة", unit: "EA", salePrice: "14.00", minPrice: "12.00", maxPrice: "17.00", opening: { qty: "500", cost: "7.75" } },
  { sku: "RM-OIL-15", barcode: "6281000000059", nameAr: "زيت دوار الشمس ١٫٥ لتر", nameEn: "Sunflower oil 1.5L", category: "مواد خام", unit: "EA", trackLots: true, salePrice: "0", opening: { qty: "120", cost: "11.50", batchNo: "B-OIL-2602" } },
];

async function findId(trx: Trx, table: "units" | "categories" | "products" | "warehouses", tenantId: string, field: string, value: string): Promise<string> {
  // table/field are compile-time constants (never user input) → sql.raw is safe here
  const r = await trx.execute(
    sql`select id from ${sql.raw(table)} where tenant_id = ${tenantId} and ${sql.raw(field)} = ${value} limit 1`,
  );
  const row = (r as unknown as { rows: { id: string }[] }).rows[0];
  if (!row) throw new Error(`seed: ${table}.${field}=${value} not found`);
  return row.id;
}

async function ensurePhase2(trx: Trx, tenantId: string, opts: { withOpeningStock: boolean }) {
  // accounting foundation
  await ensureCoa(trx, tenantId);
  await ensureMappings(trx, tenantId);
  await ensureFiscalYear(trx, tenantId, 2026);

  // warehouses
  for (const w of [
    { code: "MAIN", name: "المستودع الرئيسي", type: "main" as const },
    { code: "QUAR", name: "مستودع الحجر (تالف/منتهي)", type: "quarantine" as const },
    { code: "INTRANSIT", name: "عهد طريقية (تحويلات)", type: "in_transit" as const },
  ]) {
    const exists = await trx.execute(sql`select id from warehouses where tenant_id = ${tenantId} and code = ${w.code} limit 1`);
    if ((exists as unknown as { rows: unknown[] }).rows.length === 0) {
      await trx.insert(warehouses).values({ tenantId, code: w.code, name: w.name, type: w.type });
    }
  }

  // catalog
  for (const u of CATALOG_UNITS) {
    await trx.insert(unitTable).values({ tenantId, ...u }).onConflictDoNothing();
  }
  for (const c of ["مواد خام", "منتجات تامة", "مواد تعبئة"]) {
    const e = await trx.execute(sql`select id from categories where tenant_id = ${tenantId} and name_ar = ${c} limit 1`);
    if ((e as unknown as { rows: unknown[] }).rows.length === 0) {
      await trx.insert(categories).values({ tenantId, nameAr: c });
    }
  }
  await trx.insert(brands).values({ tenantId, name: "الأفق" }).onConflictDoNothing();

  for (const p of PRODUCT_SEEDS) {
    const exists = await trx.execute(sql`select id from products where tenant_id = ${tenantId} and sku = ${p.sku} limit 1`);
    if ((exists as unknown as { rows: unknown[] }).rows.length > 0) continue;
    const categoryId = await findId(trx, "categories", tenantId, "name_ar", p.category);
    const unitId = await findId(trx, "units", tenantId, "code", p.unit);
    const [prod] = await trx
      .insert(products)
      .values({
        tenantId,
        sku: p.sku,
        barcode: p.barcode,
        nameAr: p.nameAr,
        nameEn: p.nameEn ?? null,
        categoryId,
        stockUnitId: unitId,
        trackLots: p.trackLots ?? false,
        trackExpiry: p.trackExpiry ?? false,
        salePrice: p.salePrice,
        minPrice: p.minPrice ?? null,
        maxPrice: p.maxPrice ?? null,
      })
      .returning({ id: products.id });
    if (p.ctnFactor) {
      const ctnId = await findId(trx, "units", tenantId, "code", "CTN");
      await trx.insert(productUnits).values({ tenantId, productId: prod.id, unitId: ctnId, factor: p.ctnFactor }).onConflictDoNothing();
    }
  }

  // opening stock + opening GL (once) — P-31
  if (opts.withOpeningStock) {
    const [already] = await trx
      .select({ id: journalEntries.id })
      .from(journalEntries)
      .where(and(eq(journalEntries.tenantId, tenantId), eq(journalEntries.sourceType, "opening")))
      .limit(1);
    if (!already) {
      const ctx = { tenantId, actorId: null };
      const mainWh = await findId(trx, "warehouses", tenantId, "code", "MAIN");
      let total = new Decimal(0);
      for (const p of PRODUCT_SEEDS) {
        if (!p.opening) continue;
        const productId = await findId(trx, "products", tenantId, "sku", p.sku);
        await recordMovement(trx, ctx, {
          warehouseId: mainWh,
          productId,
          qty: p.opening.qty,
          movementType: "receive",
          unitCost: p.opening.cost,
          lot: p.trackLots && p.opening.batchNo ? { batchNo: p.opening.batchNo, expiryDate: p.opening.expiry ?? null } : undefined,
          businessDate: "2026-01-01",
          sourceType: "opening",
          sourceId: tenantId,
          effectKind: "opening_receive",
          lineRef: p.sku,
          memo: "رصيد افتتاحي",
        });
        total = total.plus(new Decimal(p.opening.qty).times(p.opening.cost));
      }
      const invAcct = await resolveMappingId(trx, tenantId, "inventory_control");
      const openEq = await resolveMappingId(trx, tenantId, "opening_equity");
      await postEntry(trx, ctx, {
        sourceType: "opening",
        sourceId: tenantId,
        effectKind: "stock_gl",
        businessDate: "2026-01-01",
        memo: "قيد المخزون الافتتاحي",
        lines: [
          { accountId: invAcct, debit: total.toFixed(), credit: "0", warehouseId: mainWh },
          { accountId: openEq, debit: "0", credit: total.toFixed() },
        ],
      });
    }
  }
}

/* ============================ Phase 3 seed ================================= */

async function ensurePhase3(trx: Trx, tenantId: string) {
  for (const c of [
    { code: "CASH-001", nameAr: "عميل نقدي عام", creditLimit: "0", paymentTermsDays: 0 },
    { code: "CUST-002", nameAr: "سوبر ماركت النور", phone: "0551112223", creditLimit: "25000", paymentTermsDays: 30 },
    { code: "CUST-003", nameAr: "بقالة الأمانة", phone: "0554447778", creditLimit: "8000", paymentTermsDays: 14 },
  ]) {
    const exists = await trx.execute(sql`select id from customers where tenant_id = ${tenantId} and code = ${c.code} limit 1`);
    if ((exists as unknown as { rows: unknown[] }).rows.length === 0) {
      await trx.insert(customers).values({ tenantId, ...c });
    }
  }
  // customer-specific price demo: النور gets a discount on orange juice
  const juiceId = (await trx.execute(sql`select id from products where tenant_id = ${tenantId} and sku = 'FG-JUICE-OR1' limit 1`)) as unknown as { rows: { id: string }[] };
  const normId = (await trx.execute(sql`select id from customers where tenant_id = ${tenantId} and code = 'CUST-002' limit 1`)) as unknown as { rows: { id: string }[] };
  if (juiceId.rows[0] && normId.rows[0]) {
    await trx
      .insert(customerPrices)
      .values({
        tenantId,
        customerId: normId.rows[0].id,
        productId: juiceId.rows[0].id,
        price: "6.00",
        effectiveFrom: "2026-01-01",
      })
      .onConflictDoNothing();
  }

  const sup = await trx.execute(sql`select id from suppliers where tenant_id = ${tenantId} and code = 'SUP-001' limit 1`);
  if ((sup as unknown as { rows: unknown[] }).rows.length === 0) {
    await trx.insert(suppliers).values({ tenantId, code: "SUP-001", nameAr: "مطاحن الوسطى", taxNumber: "310122393500005", paymentTermsDays: 45 });
  }

  for (const t of [
    { code: "CASH-MAIN", name: "الصندوق الرئيسي", kind: "cash" },
    { code: "BANK-001", name: "الحساب الجاري — بنك الرياض", kind: "bank" },
  ]) {
    const e = await trx.execute(sql`select id from treasury_accounts where tenant_id = ${tenantId} and code = ${t.code} limit 1`);
    if ((e as unknown as { rows: unknown[] }).rows.length === 0) {
      await trx.insert(treasuryAccounts).values({ tenantId, ...t });
    }
  }
}

async function main() {
  console.log("— seed: permission catalog");
  const permsAdded = await ensurePermissionCatalog();
  console.log(`   permissions catalog ready (${PERMISSIONS.length} codes, +${permsAdded} new)`);
  const revoked = await revokePlatformGrantedPermissions();
  if (revoked.grants || revoked.stale) {
    console.log(`   removed ${revoked.grants} platform grant(s) from tenant roles and ${revoked.stale} stale catalog row(s)`);
  }

  console.log("— seed: platform owner");
  const platform = await ensurePlatformOwner();
  console.log(
    `   ${platform.email} ${
      platform.created ? "(created)" : platform.passwordRefreshed ? "(exists — password refreshed)" : "(exists)"
    }`,
  );

  console.log("— seed: tenant A (الأفق)");
  const a = await ensureTenant({
    name: "شركة الأفق للتموين الغذائي",
    nameEn: "Al-Ofoq Food Supply Co.",
    legalName: "شركة الأفق للتموين الغذائي ذ.م.م",
    vatNumber: "310122393500003",
    branchName: "الرياض — الفرع الرئيسي",
    users: [
      { email: "owner@horizon.test", name: "سعد العتيبي", roleKey: "tenant_owner", job: "مالك", phone: "0500000001" },
      { email: "acc@horizon.test", name: "أحمد المحمد", roleKey: "accountant", job: "محاسب", phone: "0500000002" },
      { email: "rep@horizon.test", name: "خالد السبيعي", roleKey: "field_rep", job: "مندوب مبيعات", phone: "0500000003" },
      { email: "wh@horizon.test", name: "منير القحطاني", roleKey: "warehouse_manager", job: "أمين مستودع", phone: "0500000004" },
    ],
  });
  console.log(`   tenant: ${a.tenant.name} (${a.tenant.id}) — new users: ${a.createdUsers.length ? a.createdUsers.join(", ") : "none"}`);

  console.log("— seed: tenant B (النخبة)");
  const b = await ensureTenant({
    name: "شركة النخبة للتوزيع",
    nameEn: "Al-Nokhba Distribution Co.",
    legalName: "شركة النخبة للتوزيع ذ.م.م",
    vatNumber: "310122393500004",
    branchName: "جدة — الفرع الرئيسي",
    users: [
      { email: "owner@nokhba.test", name: "فهد الدوسري", roleKey: "tenant_owner", job: "مالك", phone: "0500000011" },
    ],
  });
  console.log(`   tenant: ${b.tenant.name} (${b.tenant.id}) — new users: ${b.createdUsers.length ? b.createdUsers.join(", ") : "none"}`);

  console.log("— seed: phase 2 (COA, periods, warehouses, catalog, opening stock)");
  await db.transaction(async (trx) => {
    await bindTenant(trx, a.tenant.id);
    await ensurePhase2(trx, a.tenant.id, { withOpeningStock: true });
  });
  await db.transaction(async (trx) => {
    await bindTenant(trx, b.tenant.id);
    await ensurePhase2(trx, b.tenant.id, { withOpeningStock: false });
  });
  console.log("   phase 2 foundation ready for both tenants");

  console.log("— seed: phase 3 (customers, supplier, treasury)");
  await db.transaction(async (trx) => {
    await bindTenant(trx, a.tenant.id);
    await ensurePhase3(trx, a.tenant.id);
  });
  await db.transaction(async (trx) => {
    await bindTenant(trx, b.tenant.id);
    await ensurePhase3(trx, b.tenant.id);
  });
  console.log("   phase 3 parties ready");

  console.log("\n✓ seed complete");
  console.log("  Demo sign-in (sandbox only):");
  console.log(`    منشأة الأفق:  owner@horizon.test / ${DEMO_PASSWORD}`);
  console.log(`                acc@horizon.test  / ${DEMO_PASSWORD}`);
  console.log(`                rep@horizon.test  / ${DEMO_PASSWORD}`);
  console.log(`    منشأة النخبة: owner@nokhba.test / ${DEMO_PASSWORD}`);
  process.exit(0);
}

main().catch((e) => {
  console.error("seed failed:", e);
  process.exit(1);
});
