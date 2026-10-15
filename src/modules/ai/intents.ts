/**
 * Registered intents for approval tickets (AI_ASSISTANT §4).
 *
 * An intent is the *only* thing the assistant may prepare. Each one names the
 * permission a human needs to approve + execute it, validates its payload with
 * zod, and executes through the normal service layer — so the effect on the books
 * is produced by a human action carrying the human's permissions, and the model
 * never gets a write path of its own.
 *
 * Hard rules baked in here:
 *  - no posting, no deletion, no reversal: drafts and export bundles only;
 *  - the payload is re-validated at execution time (a ticket can wait hours, and
 *    the model's proposal is not a trusted input);
 *  - nothing is executed from the chat turn itself — only from the approval action.
 */

import { z } from "zod";
import { withTenant, type Trx } from "@/modules/shared/db-context";
import { createDraftManual } from "@/modules/accounting/posting";
import { dec, eqMoney, roundMoney, toDb } from "@/modules/shared/money";
import { buildTenantExport } from "@/modules/platform/exports";
import { errors } from "@/modules/shared/result";

export interface IntentContext {
  tenantId: string;
  userId: string;
  /** label recorded in the audit chain (user name/email as the session knows it) */
  actorLabel: string;
}

export interface IntentExecution {
  /** what the human sees as the outcome (document id/number — never model text) */
  result: Record<string, unknown>;
  /** audited action name for the tenant chain */
  auditAction: string;
  auditEntity: string;
  auditEntityId: string;
}

export interface IntentDefinition {
  key: string;
  /** i18n key for the ticket list */
  titleKey: string;
  /** shown to the model so it proposes the right thing */
  description: string;
  requiredPermission: string;
  schema: z.ZodType;
  /** the human's turn to mutate: runs in the approver's tenant context */
  execute(ctx: IntentContext, payload: Record<string, unknown>): Promise<IntentExecution>;
}

const amount = z.number().min(0).max(100_000_000);

const journalLine = z
  .object({
    accountId: z.string().uuid(),
    debit: amount.optional(),
    credit: amount.optional(),
    memo: z.string().max(200).optional(),
  })
  .strict();

export const INTENTS: readonly IntentDefinition[] = [
  {
    key: "journal_entry_draft",
    titleKey: "ai.intentJournalDraft",
    description:
      "Prepare a draft manual journal entry (status draft, never posted). Only propose it after the user confirmed the accounts, the amounts and the business date. Posting stays in the journal screen, done by a human.",
    requiredPermission: "accounting.journal.create",
    schema: z
      .object({
        businessDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        memo: z.string().max(300).optional(),
        lines: z.array(journalLine).min(2).max(20),
      })
      .strict(),
    async execute(ctx, payload) {
      const input = payload as {
        businessDate: string;
        memo?: string;
        lines: { accountId: string; debit?: number; credit?: number; memo?: string }[];
      };
      const totalDr = roundMoney(input.lines.reduce((s, l) => s.plus(dec(l.debit ?? 0)), dec(0)));
      const totalCr = roundMoney(input.lines.reduce((s, l) => s.plus(dec(l.credit ?? 0)), dec(0)));
      if (totalDr.isZero() || !eqMoney(totalDr, totalCr)) {
        throw errors.validation("errors.journalNotBalanced", `dr=${toDb(totalDr)} cr=${toDb(totalCr)}`, {
          dr: toDb(totalDr),
          cr: toDb(totalCr),
        });
      }
      const entry = await withTenant(ctx.tenantId, (trx: Trx) =>
        createDraftManual(
          trx,
          { tenantId: ctx.tenantId, actorId: ctx.userId },
          {
            businessDate: input.businessDate,
            memo: input.memo ?? null,
            lines: input.lines.map((l) => ({
              accountId: l.accountId,
              debit: toDb(dec(l.debit ?? 0)),
              credit: toDb(dec(l.credit ?? 0)),
              memo: l.memo ?? null,
            })),
          },
        ),
      );
      return {
        result: {
          journalEntryId: entry.id,
          status: entry.status,
          businessDate: entry.businessDate,
        },
        auditAction: "ai.ticket.executed.journal_draft",
        auditEntity: "journal_entry",
        auditEntityId: entry.id,
      };
    },
  },
  {
    key: "tenant_export",
    titleKey: "ai.intentTenantExport",
    description:
      "Prepare a complete data-export bundle for this tenant (files + manifest + checksums) for the approver to download. Nothing leaves the system until the approver acts, and the download link expires.",
    requiredPermission: "reports.export",
    schema: z.object({}).strict(),
    async execute(ctx) {
      const built = await buildTenantExport({
        tenantId: ctx.tenantId,
        actorLabel: ctx.actorLabel,
        requestedByUserId: ctx.userId,
      });
      return {
        result: {
          exportId: built.exportId,
          bytes: built.bytes,
          sha256: built.sha256,
          tables: built.tables.length,
          expiresAt: built.expiresAt.toISOString(),
        },
        auditAction: "ai.ticket.executed.tenant_export",
        auditEntity: "tenant_export",
        auditEntityId: built.exportId,
      };
    },
  },
];

export function findIntent(key: string): IntentDefinition | undefined {
  return INTENTS.find((i) => i.key === key);
}

export const INTENT_KEYS: readonly string[] = INTENTS.map((i) => i.key);
