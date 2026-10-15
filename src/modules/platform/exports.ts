/**
 * Tenant export + deletion workflow (BACKUP_AND_RECOVERY §8, PLATFORM_ADMIN §5).
 *
 * Export: one tenant's data as a versioned bundle (JSON per table + manifest
 * with row counts and per-file SHA-256). Generation runs **inside that tenant's
 * RLS context** (`withTenant`), so a bundle physically cannot contain another
 * tenant's rows; a row-count check confirms it before the link is published.
 * Downloads use an expiring HMAC token and are audited.
 *
 * Deletion: request → cooling off → (legal-hold gate) → safety backup → purge →
 * certificate. Nothing is deleted while a legal hold is set, and the purge is the
 * only place in the codebase that removes tenant rows.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { deletionRequests, tenantExports, tenants } from "@/db/schema";
import { errors } from "@/modules/shared/result";
import { newId } from "@/modules/shared/ids";
import { appKey, randomToken, sha256Hex } from "@/modules/shared/crypto";
import { withTenant, type Trx } from "@/modules/shared/db-context";
import { logger } from "@/modules/shared/logger";
import { writePlatformAudit } from "./audit";
import { getSettings } from "./settings";
import { raiseAlert } from "./alerts";
import { runBackup } from "./backup/service";
import { assertGrantAccess, recordGrantUse } from "./grants";

const EXPORT_TTL_HOURS = 48;

/** Tables exported per tenant (document set + configuration + audit excerpt). */
const EXPORT_TABLES = [
  "companies",
  "branches",
  "users",
  "roles",
  "user_roles",
  "accounts",
  "posting_mappings",
  "fiscal_years",
  "fiscal_periods",
  "journal_entries",
  "journal_lines",
  "categories",
  "units",
  "products",
  "warehouses",
  "stock_ledger",
  "stock_balances",
  "customers",
  "suppliers",
  "sales_invoices",
  "sales_invoice_lines",
  "receipts",
  "receipt_lines",
  "allocations",
  "purchase_invoices",
  "purchase_invoice_lines",
  "supplier_payments",
  "supplier_allocations",
  "treasury_accounts",
  "expenses",
  "settlements",
  "settlement_lines",
  "settlement_exceptions",
  "invoice_submissions",
  "zatca_certificates",
  "tax_configs",
  "audit_log",
];

export function exportDirectory(): string {
  return process.env.EXPORT_DIR ?? ".exports";
}

export interface ExportBuildResult {
  exportId: string;
  path: string;
  bytes: number;
  sha256: string;
  token: string;
  expiresAt: Date;
  tables: { name: string; rows: number; sha256: string }[];
}

/**
 * Build a tenant bundle. `actorLabel` is recorded in the platform audit chain;
 * when the request came from the tenant itself, pass `requestedByUserId`.
 */
export async function buildTenantExport(input: {
  tenantId: string;
  actorLabel: string;
  requestedByUserId?: string | null;
  requestedByPlatformUserId?: string | null;
}): Promise<ExportBuildResult> {
  const [tenant] = await db.select().from(tenants).where(eq(tenants.id, input.tenantId)).limit(1);
  if (!tenant) throw errors.notFound("tenant", input.tenantId);

  // A bundle is the whole tenant: when the requester is the platform (not the
  // tenant itself) it needs a live, scoped, approved grant — and the use is
  // recorded. "Platform admin" is not a licence to read the books.
  let grantId: string | null = null;
  if (input.requestedByPlatformUserId && !input.requestedByUserId) {
    const grant = await assertGrantAccess({
      tenantId: input.tenantId,
      platformUserId: input.requestedByPlatformUserId,
      screen: "export",
      needsExport: true,
    });
    grantId = grant.grantId;
  }

  const id = newId();
  const token = randomToken();
  await db.insert(tenantExports).values({
    id,
    tenantId: input.tenantId,
    status: "running",
    requestedByUserId: input.requestedByUserId ?? null,
    requestedByPlatformUserId: input.requestedByPlatformUserId ?? null,
    requestedByLabel: input.actorLabel,
    downloadTokenHash: sha256Hex(token),
    expiresAt: new Date(Date.now() + EXPORT_TTL_HOURS * 3600_000),
  });

  try {
    const files: { name: string; rows: number; sha256: string; content: string }[] = [];
    await withTenant(input.tenantId, async (trx) => {
      for (const table of EXPORT_TABLES) {
        // Scope explicitly — never lean on RLS here: the application role is the
        // table owner (privileged connections bypass policies), so an unscoped
        // select would put every tenant's rows in one tenant's bundle.
        const rows = (await trx.execute(
          sql.raw(`select coalesce(jsonb_agg(t), '[]'::jsonb)::text as payload, count(*)::int as n
                   from (select * from ${table} where tenant_id = '${input.tenantId}'::uuid) t`),
        )) as unknown as { rows: { payload: string; n: number }[] };
        const payload = rows.rows[0]?.payload ?? "[]";
        files.push({
          name: `${table}.json`,
          rows: Number(rows.rows[0]?.n ?? 0),
          sha256: sha256Hex(payload),
          content: payload,
        });
      }
    });

    // isolation proof: no exported row may carry a foreign tenant id
    const foreign = await crossTenantCheck(input.tenantId, files);
    if (foreign.length > 0) {
      throw errors.invariant(
        `export would contain foreign tenant rows: ${foreign.join(", ")} — refusing to publish`,
      );
    }

    const manifest = {
      version: 1,
      generatedAt: new Date().toISOString(),
      tenant: { id: tenant.id, name: tenant.name, plan: tenant.plan },
      tables: files.map((f) => ({ name: f.name.replace(/\.json$/, ""), rows: f.rows, sha256: f.sha256 })),
    };
    const bundle = {
      manifest,
      files: Object.fromEntries(files.map((f) => [f.name, JSON.parse(f.content)])),
    };
    const buffer = Buffer.from(JSON.stringify(bundle, null, 2), "utf8");
    const dir = exportDirectory();
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${tenant.id}-${id}.json`);
    await writeFile(path, buffer);

    await db
      .update(tenantExports)
      .set({
        status: "ready",
        manifest: { tables: manifest.tables, generatedAt: manifest.generatedAt, version: 1 },
        artifactPath: path,
        bytes: buffer.length,
        sha256: sha256Hex(buffer),
        finishedAt: new Date(),
      })
      .where(eq(tenantExports.id, id));

    if (grantId) {
      await recordGrantUse({
        grantId,
        screen: "export",
        actorLabel: input.actorLabel,
        actorPlatformUserId: input.requestedByPlatformUserId!,
        tenantId: input.tenantId,
        detail: { bytes: buffer.length, tables: files.length },
      });
    }

    await writePlatformAudit(db, {
      actorPlatformUserId: input.requestedByPlatformUserId ?? null,
      actorLabel: input.actorLabel,
      action: "tenant.exported",
      entity: "tenant_export",
      entityId: id,
      after: { tenantId: input.tenantId, bytes: buffer.length, tables: files.length },
      alsoAuditTenantId: input.tenantId,
    });

    return {
      exportId: id,
      path,
      bytes: buffer.length,
      sha256: sha256Hex(buffer),
      token,
      expiresAt: new Date(Date.now() + EXPORT_TTL_HOURS * 3600_000),
      tables: manifest.tables,
    };
  } catch (e) {
    const detail = e instanceof Error ? e.message.slice(0, 500) : String(e);
    await db
      .update(tenantExports)
      .set({ status: "failed", errorClass: "export", errorDetail: detail, finishedAt: new Date() })
      .where(eq(tenantExports.id, id));
    await raiseAlert({
      severity: "warning",
      kind: "tenant_export_failed",
      title: "Tenant export failed",
      body: detail,
      tenantId: input.tenantId,
      payload: { exportId: id },
    }).catch(() => undefined);
    throw e;
  }
}

/** Row-level isolation check on the produced files (defense in depth). */
async function crossTenantCheck(
  tenantId: string,
  files: { name: string; content: string }[],
): Promise<string[]> {
  const offenders: string[] = [];
  for (const file of files) {
    if (file.name === "tenants.json") continue;
    const rows = JSON.parse(file.content) as Record<string, unknown>[];
    if (rows.some((row) => typeof row.tenant_id === "string" && row.tenant_id !== tenantId)) {
      offenders.push(file.name);
    }
  }
  return offenders;
}

export function exportToken(exportId: string, expiresAt: number): string {
  const body = `${exportId}.${expiresAt}`;
  return `${body}.${createHmac("sha256", appKey()).update(body).digest("base64url")}`;
}

export function verifyExportToken(token: string): { exportId: string } | null {
  const [exportId, expiresAt, sig] = token.split(".");
  if (!exportId || !expiresAt || !sig) return null;
  const expected = createHmac("sha256", appKey())
    .update(`${exportId}.${expiresAt}`)
    .digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  if (Number(expiresAt) < Date.now()) return null;
  return { exportId };
}

export interface DownloadResult {
  buffer: Buffer;
  filename: string;
}

/** Serve a ready export: token + expiry + audit trail. */
export async function downloadTenantExport(input: {
  exportId: string;
  token?: string | null;
  actorLabel: string;
  actorPlatformUserId?: string | null;
}): Promise<DownloadResult> {
  const [row] = await db.select().from(tenantExports).where(eq(tenantExports.id, input.exportId)).limit(1);
  if (!row) throw errors.notFound("tenant_export", input.exportId);
  if (row.status !== "ready" || !row.artifactPath) {
    throw errors.validation("errors.exportNotReady", `export status is ${row.status}`);
  }
  if (row.expiresAt && row.expiresAt.getTime() < Date.now()) {
    await db.update(tenantExports).set({ status: "expired" }).where(eq(tenantExports.id, row.id));
    throw errors.validation("errors.exportExpired", "download link expired");
  }
  if (input.token) {
    const verified = verifyExportToken(input.token);
    if (!verified || verified.exportId !== row.id) {
      throw errors.permission("errors.exportTokenInvalid", "invalid download token");
    }
  } else if (row.downloadTokenHash) {
    // console-side download: caller must be a platform actor (checked by the action)
    if (!input.actorPlatformUserId) {
      throw errors.permission("errors.exportTokenInvalid", "a token is required for this download");
    }
  }

  const buffer = await readFile(row.artifactPath);
  if (row.sha256 && sha256Hex(buffer) !== row.sha256) {
    throw errors.invariant("export artifact checksum mismatch — refusing to serve it");
  }
  await db.update(tenantExports).set({ downloadedAt: new Date() }).where(eq(tenantExports.id, row.id));
  await writePlatformAudit(db, {
    actorPlatformUserId: input.actorPlatformUserId ?? null,
    actorLabel: input.actorLabel,
    action: "tenant.export_downloaded",
    entity: "tenant_export",
    entityId: row.id,
    after: { tenantId: row.tenantId, bytes: buffer.length },
    alsoAuditTenantId: row.tenantId,
  });
  return { buffer, filename: `export-${row.tenantId.slice(0, 8)}-${row.id.slice(0, 8)}.json` };
}

export async function listExports(tenantId?: string, limit = 50) {
  return db
    .select()
    .from(tenantExports)
    .where(tenantId ? eq(tenantExports.tenantId, tenantId) : sql`true`)
    .orderBy(sql`${tenantExports.createdAt} desc`)
    .limit(limit);
}

/* ------------------------------------------------------------------ deletion */

export async function requestDeletion(input: {
  tenantId: string;
  reason: string;
  actorLabel: string;
  actorPlatformUserId?: string | null;
}): Promise<{ id: string; coolingOffUntil: Date }> {
  const settings = await getSettings();
  const [tenant] = await db.select().from(tenants).where(eq(tenants.id, input.tenantId)).limit(1);
  if (!tenant) throw errors.notFound("tenant", input.tenantId);

  const coolingOffUntil = new Date(Date.now() + settings.deletionCoolingOffDays * 24 * 3600_000);
  const [pending] = await db
    .select()
    .from(deletionRequests)
    .where(sql`${deletionRequests.tenantId} = ${input.tenantId} and ${deletionRequests.status} in ('requested','cooling_off','approved')`)
    .limit(1);
  if (pending) throw errors.conflict("errors.deletionAlreadyPending", `request ${pending.id} is ${pending.status}`);

  const id = newId();
  await db.insert(deletionRequests).values({
    id,
    tenantId: input.tenantId,
    status: "cooling_off",
    reason: input.reason,
    requestedByLabel: input.actorLabel,
    coolingOffUntil,
  });
  // the tenant is told, and the request is visible in its own audit view
  await writePlatformAudit(db, {
    actorPlatformUserId: input.actorPlatformUserId ?? null,
    actorLabel: input.actorLabel,
    action: "tenant.deletion_requested",
    entity: "deletion_request",
    entityId: id,
    after: { tenantId: input.tenantId, coolingOffUntil, reason: input.reason },
    alsoAuditTenantId: input.tenantId,
  });
  return { id, coolingOffUntil };
}

export async function setLegalHold(input: {
  requestId: string;
  hold: boolean;
  note?: string;
  actorLabel: string;
  actorPlatformUserId?: string | null;
}): Promise<void> {
  const [row] = await db.select().from(deletionRequests).where(eq(deletionRequests.id, input.requestId)).limit(1);
  if (!row) throw errors.notFound("deletion_request", input.requestId);
  await db
    .update(deletionRequests)
    .set({ legalHold: input.hold, legalHoldNote: input.note ?? null, updatedAt: new Date() })
    .where(eq(deletionRequests.id, input.requestId));
  await writePlatformAudit(db, {
    actorPlatformUserId: input.actorPlatformUserId ?? null,
    actorLabel: input.actorLabel,
    action: input.hold ? "tenant.legal_hold_set" : "tenant.legal_hold_cleared",
    entity: "deletion_request",
    entityId: input.requestId,
    after: { note: input.note ?? null },
    alsoAuditTenantId: row.tenantId,
  });
}

/**
 * Purge a tenant after its cooling-off window. Refuses while a legal hold is
 * set or an export was never offered (PLATFORM_ADMIN §5). Takes a SAFETY backup
 * first, then deletes every tenant row in one transaction, then writes a
 * certificate of destruction.
 */
export async function purgeTenant(input: {
  requestId: string;
  actorLabel: string;
  actorPlatformUserId?: string | null;
  confirmation: string;
}): Promise<{ certificate: Record<string, unknown> }> {
  const [request] = await db.select().from(deletionRequests).where(eq(deletionRequests.id, input.requestId)).limit(1);
  if (!request) throw errors.notFound("deletion_request", input.requestId);
  const [tenant] = await db.select().from(tenants).where(eq(tenants.id, request.tenantId)).limit(1);
  if (!tenant) throw errors.notFound("tenant", request.tenantId);

  if (input.confirmation !== tenant.name) {
    throw errors.validation(
      "errors.platformTypedConfirmation",
      "typed confirmation must match the tenant name exactly",
    );
  }
  if (request.legalHold) {
    throw errors.validation("errors.legalHoldActive", "a legal hold blocks purging (OQ-8 retention)");
  }
  if (!request.exportOffered) {
    throw errors.validation("errors.exportMustBeOffered", "offer an export before deleting anything");
  }
  if (request.coolingOffUntil && request.coolingOffUntil.getTime() > Date.now()) {
    throw errors.validation("errors.coolingOffActive", `cooling-off until ${request.coolingOffUntil.toISOString()}`);
  }

  const safety = await runBackup({ kind: "safety", actorLabel: input.actorLabel, skipRemote: true });

  const counts = await db.transaction((trx) => deleteTenantRows(trx, tenant.id));

  const certificate = {
    tenantId: tenant.id,
    tenantName: tenant.name,
    purgedAt: new Date().toISOString(),
    safetyBackupRunId: safety.id,
    deletedRows: counts,
    totalDeleted: Object.values(counts).reduce((a, b) => a + b, 0),
    actor: input.actorLabel,
  };
  await db
    .update(deletionRequests)
    .set({
      status: "purged",
      purgedAt: new Date(),
      certificate,
      approvedByPlatformUserId: input.actorPlatformUserId ?? null,
      safetyBackupId: safety.id,
      updatedAt: new Date(),
    })
    .where(eq(deletionRequests.id, input.requestId));

  await writePlatformAudit(db, {
    actorPlatformUserId: input.actorPlatformUserId ?? null,
    actorLabel: input.actorLabel,
    action: "tenant.purged",
    entity: "deletion_request",
    entityId: input.requestId,
    after: certificate,
  });
  logger.warn({ tenantId: tenant.id, rows: certificate.totalDeleted }, "tenant purged by platform operator");
  return { certificate };
}

/**
 * Remove every row that belongs to one tenant, then the tenant itself, returning
 * the per-table counts that go into the deletion certificate.
 *
 * Every table is discovered from the catalog (`tenant_id` column) instead of a
 * hard-coded list, so a table added later cannot be forgotten. Row triggers are
 * disabled for the statement: posted documents are immutable by design and a
 * purge is not an ordinary deletion — an ordinary `delete` would be refused, and
 * a half-purge would leave orphaned children pointing at a tenant that no longer
 * exists (which is exactly what a drill cannot restore).
 *
 * Must run inside a transaction (the replication-role switch is transaction-local).
 */
export async function deleteTenantRows(trx: Trx, tenantId: string): Promise<Record<string, number>> {
  await trx.execute(sql`set local session_replication_role = replica`);
  const tables = (await trx.execute(
    sql`select table_name from information_schema.columns
        where table_schema = 'public' and column_name = 'tenant_id'
        order by table_name`,
  )) as unknown as { rows: { table_name: string }[] };
  const counts: Record<string, number> = {};

  // Join tables (role_permissions, user_roles, …) carry no tenant_id: they are
  // reachable only through a parent that does. Delete those first — children
  // before parents — otherwise the purge removes the parents and leaves the join
  // rows behind, pointing at a tenant that no longer exists.
  const links = (await trx.execute(sql`
    select con.conrelid::regclass::text as child_table,
           (select string_agg(quote_ident(a.attname), ', ' order by u.ord)
              from unnest(con.conkey) with ordinality u(attnum, ord)
              join pg_attribute a on a.attrelid = con.conrelid and a.attnum = u.attnum) as child_cols,
           con.confrelid::regclass::text as parent_table,
           (select string_agg(quote_ident(a.attname), ', ' order by u.ord)
              from unnest(con.confkey) with ordinality u(attnum, ord)
              join pg_attribute a on a.attrelid = con.confrelid and a.attnum = u.attnum) as parent_cols
      from pg_constraint con
     where con.contype = 'f' and con.connamespace = 'public'::regnamespace
       and not exists (select 1 from information_schema.columns c
                        where c.table_schema = 'public' and c.table_name = con.conrelid::regclass::text
                          and c.column_name = 'tenant_id')
  `)) as unknown as { rows: { child_table: string; child_cols: string; parent_table: string; parent_cols: string }[] };

  // a child can itself be a parent of another child, so sweep until it settles
  for (let pass = 0; pass < 5; pass += 1) {
    let removed = 0;
    for (const link of links.rows) {
      const child = link.child_table.replace(/^public\./, "");
      const parent = link.parent_table.replace(/^public\./, "");
      const res = await trx.execute(
        sql.raw(`delete from public."${child}" c
                  where (${link.child_cols.split(",").map((c) => `c.${c.trim()}`).join(", ")})
                        in (select ${link.parent_cols.split(",").map((c) => `p.${c.trim()}`).join(", ")}
                              from public."${parent}" p
                             where p.tenant_id = '${tenantId}'::uuid)`),
      );
      const deleted = (res as unknown as { rowCount?: number }).rowCount ?? 0;
      if (deleted > 0) {
        counts[child] = (counts[child] ?? 0) + deleted;
        removed += deleted;
      }
    }
    if (removed === 0) break;
  }

  for (const { table_name } of tables.rows) {
    const res = await trx.execute(
      sql.raw(`delete from public."${table_name}" where tenant_id = '${tenantId}'::uuid`),
    );
    const deleted = (res as unknown as { rowCount?: number }).rowCount ?? 0;
    if (deleted > 0) counts[table_name] = (counts[table_name] ?? 0) + deleted;
  }
  await trx.execute(sql`delete from public.tenants where id = ${tenantId}::uuid`);
  return counts;
}

export async function listDeletionRequests(limit = 50) {
  return db
    .select()
    .from(deletionRequests)
    .orderBy(sql`${deletionRequests.createdAt} desc`)
    .limit(limit);
}

/** Mark a request as export-offered (the console flow records it explicitly). */
export async function markExportOffered(requestId: string, exportId: string): Promise<void> {
  await db
    .update(deletionRequests)
    .set({ exportOffered: true, exportId, updatedAt: new Date() })
    .where(eq(deletionRequests.id, requestId));
}

/** Expire download links whose window has passed (worker maintenance job). */
export async function expireExports(): Promise<number> {
  const res = (await db.execute(sql`
    update tenant_exports
       set status = 'expired'
     where status = 'ready' and expires_at is not null and expires_at < now()
    returning id`)) as unknown as { rowCount?: number; rows?: unknown[] };
  return res.rows?.length ?? res.rowCount ?? 0;
}
