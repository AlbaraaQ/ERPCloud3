/**
 * Tool registry (AI_ASSISTANT §3) — the ONLY way the model reaches data.
 *
 * Rules that make this a boundary rather than a convenience:
 *   1. every tool declares the permission it needs, and the permission is checked
 *      against the *session* before the tool body runs;
 *   2. every tool runs inside the caller's tenant transaction — a tenant id is
 *      never an input, so no argument the model produces can point at another
 *      tenant;
 *   3. arguments are validated by zod and then narrowed again (row caps, uuid
 *      shapes): junk from a model must fail closed;
 *   4. figures come from the Phase 7 report services — the assistant never
 *      re-implements a number, so it cannot disagree with the screens;
 *   5. a tool whose source report is not implemented says so (`unavailable`)
 *      instead of returning a plausible zero;
 *   6. output is capped and, for names, masked unless the tenant allowed names.
 */

import { z } from "zod";
import type { Trx } from "@/modules/shared/db-context";
import { errors } from "@/modules/shared/result";
import { todayBusinessDate } from "@/modules/shared/dates";
import { salesByDimension, collections, incomeStatement } from "@/modules/reports/sales";
import { arAging } from "@/modules/reports/receivables";
import { expiryBands, movementLedger, stockMovementsWithoutJournal } from "@/modules/reports/inventory";
import { expenseAnalysis, settlementHistory, stockHealth } from "@/modules/reports/ops";
import type { AiDataScope } from "./config";

export interface ToolContext {
  tenantId: string;
  userId: string;
  permissions: ReadonlySet<string>;
  dataScope: AiDataScope;
  locale: "ar" | "en";
  /** business date for "today" questions (tenant timezone semantics) */
  today: string;
}

export interface ToolOutcome {
  /** structured payload handed back to the model (already capped/masked) */
  data: Record<string, unknown>;
  /** rows the tool actually produced (audit) */
  rows: number;
  /** short factual lines the UI can show without the model */
  summary: string[];
  /** set when the tool cannot answer — the model must relay this, not invent */
  unavailable?: { reason: string };
}

export interface AiTool {
  name: string;
  description: string;
  /** permission code from the tenant catalog (SECURITY_AND_TENANCY §4) */
  permission: string;
  schema: z.ZodType;
  /** needs real party/product names to be useful → masked under metrics_only */
  needsNames?: boolean;
  run(ctx: ToolContext, args: Record<string, unknown>, trx: Trx): Promise<ToolOutcome>;
  /** declared when the underlying report is not implemented in this build */
  unavailableReason?: string;
}

/* --------------------------------------------------------------- helpers */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, "expected uuid");
const LIMIT_MAX = 50;

/** Stable masked label for a party/product when names are not allowed (C-1042). */
export function maskedLabel(kind: "C" | "P" | "R" | "W", id: string): string {
  let hash = 2166136261;
  for (let i = 0; i < id.length; i += 1) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return `${kind}-${(hash % 9000) + 1000}`;
}

/** Apply the tenant's data scope to a label; `metrics_only` keeps a stable code. */
export function label(ctx: ToolContext, kind: "C" | "P" | "R" | "W", id: string, name: string | null): string {
  if (ctx.dataScope === "names_allowed") return name ?? maskedLabel(kind, id);
  return maskedLabel(kind, id);
}

/** Shift a business date by whole days (business dates are ISO strings). */
export function shiftDate(date: string, days: number): string {
  const t = Date.parse(`${date}T00:00:00Z`) + days * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

function monthStart(date: string): string {
  return `${date.slice(0, 7)}-01`;
}

function cap<T>(rows: T[], limit: number): T[] {
  return rows.slice(0, limit);
}

/* ----------------------------------------------------------------- tools */

const noArgs = z.object({}).strict();

export const TOOLS: readonly AiTool[] = [
  {
    name: "sales_today",
    description:
      "Net sales, VAT and document count for today compared with yesterday. Reuses the sales-by-date report; no customer identities.",
    permission: "sales.invoice.view",
    schema: noArgs,
    async run(ctx, _args, trx) {
      const load = async (date: string) => {
        const { rows, totals } = await salesByDimension(trx, ctx.tenantId, { from: date, to: date }, "date");
        return { date, rows: rows.length, totals };
      };
      const today = await load(ctx.today);
      const yesterday = await load(shiftDate(ctx.today, -1));
      return {
        rows: 2,
        data: {
          currency: "SAR",
          today: { date: today.date, net: today.totals.net, vat: today.totals.vat, total: today.totals.total, documents: today.totals.documents },
          yesterday: {
            date: yesterday.date,
            net: yesterday.totals.net,
            vat: yesterday.totals.vat,
            total: yesterday.totals.total,
            documents: yesterday.totals.documents,
          },
        },
        summary: [
          `${today.date}: net ${today.totals.net} SAR over ${today.totals.documents} document(s)`,
          `${yesterday.date}: net ${yesterday.totals.net} SAR over ${yesterday.totals.documents} document(s)`,
        ],
      };
    },
  },
  {
    name: "collections_today",
    description: "Receipts collected today by payment method, plus the amount still pending (not yet settled), compared with yesterday.",
    permission: "sales.invoice.view",
    schema: noArgs,
    async run(ctx, _args, trx) {
      const today = await collections(trx, ctx.tenantId, { from: ctx.today, to: ctx.today });
      const yesterday = await collections(trx, ctx.tenantId, { from: shiftDate(ctx.today, -1), to: shiftDate(ctx.today, -1) });
      return {
        rows: today.rows.length,
        data: {
          currency: "SAR",
          today: { total: today.total, pending: today.pendingTotal, byMethod: today.rows },
          yesterday: { total: yesterday.total, pending: yesterday.pendingTotal },
        },
        summary: [
          `collected today ${today.total} SAR (pending ${today.pendingTotal})`,
          `collected yesterday ${yesterday.total} SAR`,
        ],
      };
    },
  },
  {
    name: "overdue_receivables",
    description: "Top overdue customers with their outstanding amount and age in days, plus the aging buckets. Names are masked unless the tenant allowed names.",
    permission: "reports.view",
    needsNames: true,
    schema: z.object({ limit: z.number().int().min(1).max(LIMIT_MAX).optional(), minDays: z.number().int().min(0).max(3650).optional() }).strict(),
    async run(ctx, args, trx) {
      const limit = Math.min(Number(args.limit ?? 20), LIMIT_MAX);
      const minDays = Number(args.minDays ?? 1);
      const aging = await arAging(trx, ctx.tenantId, { asOf: ctx.today });
      const overdue = aging.rows
        .map((row) => ({
          code: label(ctx, "C", row.partyId, row.partyName),
          outstanding: row.total,
          overdueDays: row.oldestDueDate ? Math.max(0, Math.floor((Date.parse(`${ctx.today}T00:00:00Z`) - Date.parse(`${row.oldestDueDate}T00:00:00Z`)) / 86_400_000)) : 0,
          hasOverdue: row.d1_30 + row.d31_60 + row.d61_90 + row.d90_plus > 0,
        }))
        .filter((row) => row.hasOverdue && row.overdueDays >= minDays)
        .sort((a, b) => b.outstanding - a.outstanding);
      return {
        rows: Math.min(overdue.length, limit),
        data: {
          currency: "SAR",
          asOf: aging.asOf,
          totalOutstanding: aging.totalOutstanding,
          buckets: aging.buckets,
          coverageNote: aging.coverageNote ?? null,
          customers: cap(overdue, limit).map(({ code, outstanding, overdueDays }) => ({ code, outstanding, overdueDays })),
        },
        summary: [
          `total outstanding ${aging.totalOutstanding} SAR as of ${aging.asOf}`,
          ...cap(overdue, 3).map((r) => `${r.code}: ${r.outstanding} SAR overdue ${r.overdueDays} day(s)`),
        ],
      };
    },
  },
  {
    name: "unsettled_reps",
    description: "Sales representatives with settlements that are requested or under review, with the counted-vs-expected difference.",
    permission: "settlement.review",
    needsNames: true,
    schema: z.object({ days: z.number().int().min(1).max(180).optional() }).strict(),
    async run(ctx, args, trx) {
      const days = Math.min(Number(args.days ?? 90), 180);
      const history = await settlementHistory(trx, ctx.tenantId, { from: shiftDate(ctx.today, -days), to: ctx.today });
      const open = history.rows.filter((r) => r.status === "requested" || r.status === "under_review");
      const byRep = new Map<string, { code: string; settlements: number; difference: number; oldest: string }>();
      for (const row of open) {
        const current = byRep.get(row.repUserId);
        const entry = current ?? { code: maskedLabel("R", row.repUserId), settlements: 0, difference: 0, oldest: row.businessDate };
        entry.settlements += 1;
        entry.difference = Number((entry.difference + row.difference).toFixed(2));
        entry.oldest = row.businessDate < entry.oldest ? row.businessDate : entry.oldest;
        byRep.set(row.repUserId, entry);
      }
      const reps = [...byRep.values()].sort((a, b) => a.oldest.localeCompare(b.oldest));
      return {
        rows: reps.length,
        data: { currency: "SAR", windowDays: days, reps: cap(reps, LIMIT_MAX) },
        summary: reps.length === 0 ? ["no open settlements in the window"] : reps.slice(0, 3).map((r) => `${r.code}: ${r.settlements} open, difference ${r.difference} SAR`),
      };
    },
  },
  {
    name: "low_stock",
    description: "Products below their minimum quantity, per warehouse, with the available quantity and the minimum.",
    permission: "inventory.view",
    needsNames: true,
    schema: z.object({ limit: z.number().int().min(1).max(LIMIT_MAX).optional() }).strict(),
    async run(ctx, args, trx) {
      const limit = Math.min(Number(args.limit ?? 20), LIMIT_MAX);
      const health = await stockHealth(trx, ctx.tenantId, ctx.today);
      const items = cap(health.lowStock, limit).map((row) => ({
        code: label(ctx, "P", row.sku, row.nameAr),
        warehouse: row.warehouseName,
        available: row.available,
        minQty: row.minQty,
      }));
      return {
        rows: health.lowStock.length,
        data: { asOf: ctx.today, count: health.lowStock.length, items },
        summary:
          health.lowStock.length === 0
            ? ["no product is below its minimum"]
            : [`${health.lowStock.length} product(s) below minimum`, ...items.slice(0, 3).map((i) => `${i.code} available ${i.available} < min ${i.minQty}`)],
      };
    },
  },
  {
    name: "expiry_soon",
    description: "Stock quantity by expiry band (expired, 30/60/90 days, later) for lot-tracked products.",
    permission: "inventory.view",
    schema: z.object({}).strict(),
    async run(ctx, _args, trx) {
      const bands = await expiryBands(trx, ctx.tenantId, ctx.today);
      const total = bands.expired + bands.d30 + bands.d60 + bands.d90 + bands.later;
      return {
        rows: 5,
        data: { asOf: ctx.today, ...bands, totalQty: total },
        summary:
          total === 0
            ? ["no lot-tracked stock on hand"]
            : [`expired ${bands.expired}, ≤30d ${bands.d30}, ≤60d ${bands.d60}, ≤90d ${bands.d90} (quantity)`],
      };
    },
  },
  {
    name: "income_statement_summary",
    description: "Revenue, expense and net income for a period (default: month to date) with the account breakdown by revenue/expense type.",
    permission: "reports.financial.view",
    schema: z.object({ from: isoDate.optional(), to: isoDate.optional() }).strict(),
    async run(ctx, args, trx) {
      const from = typeof args.from === "string" ? args.from : monthStart(ctx.today);
      const to = typeof args.to === "string" ? args.to : ctx.today;
      if (from > to) throw errors.validation("errors.aiBadRange", `from ${from} after to ${to}`);
      const statement = await incomeStatement(trx, ctx.tenantId, { from, to });
      return {
        rows: statement.byAccount.length,
        data: {
          currency: "SAR",
          from,
          to,
          revenue: statement.revenue,
          expense: statement.expense,
          netIncome: statement.netIncome,
          accounts: cap(statement.byAccount, 25).map((a) => ({ code: a.code, type: a.type, amount: a.amount })),
        },
        summary: [
          `${from} → ${to}: revenue ${statement.revenue} SAR, expense ${statement.expense} SAR, net ${statement.netIncome} SAR`,
        ],
      };
    },
  },
  {
    name: "expense_anomalies",
    description: "Expense categories whose amount in the window is more than 1.5× their average over the previous three periods.",
    permission: "reports.financial.view",
    schema: z.object({ from: isoDate.optional(), to: isoDate.optional() }).strict(),
    async run(ctx, args, trx) {
      const to = typeof args.to === "string" ? args.to : ctx.today;
      const from = typeof args.from === "string" ? args.from : monthStart(ctx.today);
      const windowDays = Math.max(1, Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1);
      const current = await expenseAnalysis(trx, ctx.tenantId, { from, to });
      const baselines: number[][] = [];
      for (let i = 1; i <= 3; i += 1) {
        const bTo = shiftDate(from, -1 - (i - 1) * windowDays);
        const bFrom = shiftDate(bTo, -(windowDays - 1));
        const analysis = await expenseAnalysis(trx, ctx.tenantId, { from: bFrom, to: bTo });
        baselines.push(analysis.rows.map((r) => r.amount));
      }
      const spikes = current.rows
        .map((row, index) => {
          const history = baselines.map((amounts) => amounts[index] ?? 0);
          const average = history.reduce((a, b) => a + b, 0) / Math.max(1, history.length);
          const ratio = average > 0 ? row.amount / average : null;
          return { category: row.category, amount: row.amount, baselineAverage: Number(average.toFixed(2)), ratio: ratio === null ? null : Number(ratio.toFixed(2)) };
        })
        .filter((row) => row.ratio !== null && row.ratio >= 1.5)
        .sort((a, b) => (b.ratio ?? 0) - (a.ratio ?? 0));
      const covered = baselines.some((amounts) => amounts.some((a) => a > 0));
      return {
        rows: spikes.length,
        data: {
          currency: "SAR",
          from,
          to,
          baselineCovered: covered,
          note: covered ? null : "no expense data in the baseline periods — no comparison possible",
          spikes: cap(spikes, 20),
        },
        summary: covered
          ? spikes.length === 0
            ? [`no category above 1.5× baseline in ${from} → ${to}`]
            : spikes.slice(0, 3).map((s) => `${s.category}: ${s.amount} SAR (${s.ratio}× the 3-period average)`)
          : ["baseline periods contain no expenses — comparison withheld"],
      };
    },
  },
  {
    name: "stock_variance_explain",
    description:
      "Decompose a stock value difference for one product/warehouse: the movements in the window by type, and the movements that have no journal effect on the inventory control account.",
    permission: "inventory.view",
    needsNames: true,
    schema: z.object({ productId: uuid.optional(), warehouseId: uuid.optional(), days: z.number().int().min(1).max(365).optional() }).strict(),
    async run(ctx, args, trx) {
      const days = Math.min(Number(args.days ?? 30), 365);
      const from = shiftDate(ctx.today, -days);
      const productId = typeof args.productId === "string" ? args.productId : undefined;
      const warehouseId = typeof args.warehouseId === "string" ? args.warehouseId : undefined;
      const ledger = await movementLedger(trx, ctx.tenantId, { productId, warehouseId, from, to: ctx.today, limit: 500 });
      const byType = new Map<string, { movementType: string; movements: number; qty: number; value: number }>();
      for (const row of ledger) {
        const entry = byType.get(row.movementType) ?? { movementType: row.movementType, movements: 0, qty: 0, value: 0 };
        entry.movements += 1;
        entry.qty = Number((entry.qty + row.qty).toFixed(3));
        entry.value = Number((entry.value + row.value).toFixed(2));
        byType.set(row.movementType, entry);
      }
      const unexplained = await stockMovementsWithoutJournal(trx, ctx.tenantId, { from, to: ctx.today });
      // The user's own memo on a movement is usually the explanation being asked
      // for — but a memo is free text that can name a person or a customer, so the
      // tenant's data scope decides: `metrics_only` withholds it entirely (masking
      // prose would imply it was checked, and it is not).
      const memoAllowed = ctx.dataScope === "names_allowed";
      return {
        rows: ledger.length,
        data: {
          currency: "SAR",
          from,
          to: ctx.today,
          productId: productId ?? null,
          warehouseId: warehouseId ?? null,
          movements: cap([...byType.values()].sort((a, b) => Math.abs(b.value) - Math.abs(a.value)), 12),
          withoutJournalEffect: unexplained,
          recentMovements: cap(
            ledger.slice(-10).map((row) => ({
              businessDate: row.businessDate,
              movementType: row.movementType,
              qty: row.qty,
              value: row.value,
              memo: memoAllowed ? row.memo : null,
            })),
            10,
          ),
          memos: memoAllowed ? "included (tenant scope: names_allowed)" : "withheld (tenant scope: metrics_only)",
        },
        summary: [
          `${ledger.length} movement(s) between ${from} and ${ctx.today}`,
          `${unexplained.count} movement(s) with no journal effect on the control account (value ${unexplained.value} SAR)`,
        ],
      };
    },
  },
  {
    name: "price_anomalies",
    description: "Price overrides and discount outliers in a range.",
    permission: "sales.invoice.view",
    // Honest by construction: the underlying report (R-24) is not implemented in
    // this build, so the tool refuses with the reason instead of guessing at
    // outliers from raw amounts.
    unavailableReason:
      "report R-24 (price overrides) is not implemented in this build — price-boundary overrides are not recorded per line yet",
    schema: z.object({}).strict(),
    async run() {
      throw errors.configuration("errors.aiToolUnavailable", "price_anomalies: R-24 pending");
    },
  },
];

export const TOOL_NAMES: readonly string[] = TOOLS.map((t) => t.name);

export function findTool(name: string): AiTool | undefined {
  return TOOLS.find((t) => t.name === name);
}

/**
 * The tools a session may actually use: registered, available, and permitted.
 * An unavailable tool stays in the list (so the model can explain the gap) but is
 * marked in its description.
 */
export function toolsForSession(permissions: ReadonlySet<string>): AiTool[] {
  return TOOLS.filter((tool) => permissions.has(tool.permission));
}

export function toolSpecsForSession(permissions: ReadonlySet<string>): { name: string; description: string; parameters: Record<string, unknown> }[] {
  return toolsForSession(permissions).map((tool) => ({
    name: tool.name,
    description: tool.unavailableReason ? `${tool.description} (currently unavailable: ${tool.unavailableReason})` : tool.description,
    parameters: zodToJsonSchema(tool.schema),
  }));
}

/** Minimal JSON-Schema projection of the tool's zod schema (no external dep). */
export function zodToJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const def = (schema as unknown as { def?: { type?: string; shape?: Record<string, unknown> } }).def;
  const json = z.toJSONSchema(schema, { target: "draft-7", io: "input" }) as Record<string, unknown>;
  // keep it small: the model only needs properties/required, not $schema noise
  delete json.$schema;
  if (!def) return json;
  return json;
}

export interface ToolRunResult extends ToolOutcome {
  toolName: string;
  ok: boolean;
  deniedReason?: string;
  /** true when the model asked for something it is not allowed to have */
  escalation?: boolean;
}

/**
 * Validate + authorize + run one tool call.
 *
 * Never throws: a refusal is data the model must relay. Callers record the outcome
 * in `ai_tool_calls`, including refusals — a model probing for data it may not
 * read is exactly the signal the audit trail exists to surface.
 */
export async function runTool(
  ctx: ToolContext,
  call: { name: string; args: unknown },
  trx: Trx,
): Promise<ToolRunResult> {
  const tool = findTool(call.name);
  if (!tool) {
    return {
      toolName: call.name,
      ok: false,
      deniedReason: "unknown_tool",
      escalation: true,
      rows: 0,
      data: { error: "unknown tool" },
      summary: [],
    };
  }
  if (!ctx.permissions.has(tool.permission)) {
    return {
      toolName: tool.name,
      ok: false,
      deniedReason: `missing_permission:${tool.permission}`,
      escalation: true,
      rows: 0,
      data: { error: "permission denied", requiredPermission: tool.permission },
      summary: [],
    };
  }
  if (tool.unavailableReason) {
    return {
      toolName: tool.name,
      ok: false,
      deniedReason: "tool_unavailable",
      rows: 0,
      data: { error: "unavailable", reason: tool.unavailableReason },
      summary: [],
      unavailable: { reason: tool.unavailableReason },
    };
  }

  const parsed = tool.schema.safeParse(call.args ?? {});
  if (!parsed.success) {
    return {
      toolName: tool.name,
      ok: false,
      deniedReason: "invalid_arguments",
      rows: 0,
      data: { error: "invalid arguments", issues: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`) },
      summary: [],
    };
  }

  try {
    const outcome = await tool.run(ctx, parsed.data as Record<string, unknown>, trx);
    return { toolName: tool.name, ok: true, ...outcome };
  } catch (e) {
    const detail = e instanceof Error ? e.message.slice(0, 200) : String(e);
    return {
      toolName: tool.name,
      ok: false,
      deniedReason: "tool_error",
      rows: 0,
      data: { error: "tool failed", detail },
      summary: [],
    };
  }
}

/** Business date used for "today" — always the tenant's, never the caller's clock. */
export function businessToday(): string {
  return todayBusinessDate();
}
