"use server";

/**
 * Assistant server actions (AI_ASSISTANT §2, §4).
 *
 * Three entry points, nothing else:
 *   - askAiAction            — one chat turn (read-only data, audited);
 *   - saveAiSettingsAction   — the tenant's own assistant configuration;
 *   - decideTicketAction     — a human approves/rejects a prepared action, and an
 *                              approval *executes through the normal services*.
 *
 * The model never calls anything here. It proposes; these are the human's levers.
 */

import { revalidatePath } from "next/cache";
import { getSessionContext } from "@/modules/identity/auth";
import { requireOperableTenant } from "@/modules/shared/context";
import { getLocale } from "@/i18n";
import { logger } from "@/modules/shared/logger";
import { errors, isDomainError } from "@/modules/shared/result";
import type { ActionResult } from "@/modules/shared/action-result";
import { askAssistant, messageFor, type AskResult, type AssistantSession } from "./chat";
import { saveAiConfig } from "./config";
import { decideTicket, expireTickets } from "./tickets";

/** Build the assistant session from the request's own tenant session. */
async function assistantSession(): Promise<
  { ok: true; session: AssistantSession } | { ok: false; key: string }
> {
  const ctx = await getSessionContext();
  if (!ctx?.tenant || !ctx.userId) return { ok: false, key: "errors.sessionInvalid" };
  const tenant = requireOperableTenant(ctx);
  const locale = await getLocale();
  return {
    ok: true,
    session: {
      tenantId: tenant.id,
      tenantName: tenant.name,
      userId: ctx.userId,
      actorLabel: `${ctx.userName} <${ctx.userEmail}>`,
      locale,
      permissions: ctx.permissions,
    },
  };
}

/* ------------------------------------------------------------------ chat */

/**
 * One conversation turn.
 *
 * The session (tenant + user + permissions) is taken from the cookie, never from
 * the request body: a client cannot ask as somebody else, and cannot widen its
 * own permissions by editing the payload.
 */
export async function askAiAction(input: {
  message: string;
  conversationId?: string | null;
}): Promise<AskResult & ActionResult> {
  const resolved = await assistantSession();
  if (!resolved.ok) {
    const locale = await getLocale();
    return {
      ok: false,
      conversationId: null,
      answer: messageFor(locale, resolved.key),
      answerKey: resolved.key,
      reasonKey: resolved.key,
      errorKey: resolved.key,
      usedTools: [],
      tickets: [],
      injectionFlags: 0,
      rounds: 0,
      model: null,
      tokensIn: 0,
      tokensOut: 0,
    } as AskResult & ActionResult;
  }

  try {
    const result = await askAssistant({
      session: resolved.session,
      message: input.message ?? "",
      conversationId: input.conversationId ?? null,
    });
    revalidatePath("/assistant");
    return { ...result, errorKey: result.ok ? undefined : result.reasonKey } as AskResult & ActionResult;
  } catch (e) {
    if (isDomainError(e)) return failure(e.messageKey, resolved.session);
    logger.error({ err: e }, "assistant turn failed");
    return failure("errors.unexpected", resolved.session);
  }
}

function failure(key: string, session: AssistantSession): AskResult & ActionResult {
  return {
    ok: false,
    conversationId: null,
    answer: messageFor(session.locale, key),
    answerKey: key,
    reasonKey: key,
    errorKey: key,
    usedTools: [],
    tickets: [],
    injectionFlags: 0,
    rounds: 0,
    model: null,
    tokensIn: 0,
    tokensOut: 0,
  } as AskResult & ActionResult;
}

/* -------------------------------------------------------------- settings */

/**
 * Save the tenant's assistant configuration.
 *
 * The key is NOT part of this form: the row stores the NAME of the environment
 * variable that holds it (`secretRef`), so a settings page can never carry a
 * secret into the database, a transcript or a browser history entry.
 */
export async function saveAiSettingsAction(formData: FormData): Promise<ActionResult> {
  const ctx = await getSessionContext();
  if (!ctx?.tenant || !ctx.userId) return { ok: false, errorKey: "errors.sessionInvalid" };
  try {
    if (!ctx.permissions.has("settings.company.manage")) throw errors.permission("settings.company.manage");
    const tenant = requireOperableTenant(ctx);

    await saveAiConfig({
      tenantId: tenant.id,
      actorUserId: ctx.userId,
      actorLabel: `${ctx.userName} <${ctx.userEmail}>`,
      patch: {
        enabled: String(formData.get("enabled") ?? "") === "on",
        provider: String(formData.get("provider") ?? "openai"),
        model: String(formData.get("model") ?? "").trim(),
        baseUrl: String(formData.get("baseUrl") ?? "").trim() || null,
        secretRef: String(formData.get("secretRef") ?? "").trim() || null,
        dataScope:
          String(formData.get("dataScope") ?? "metrics_only") === "names_allowed" ? "names_allowed" : "metrics_only",
        retentionDays: Number.parseInt(String(formData.get("retentionDays") ?? "30"), 10) || 30,
      },
    });
    revalidatePath("/assistant");
    revalidatePath("/assistant/settings");
    return { ok: true, okKey: "ai.settingsSaved" };
  } catch (e) {
    if (isDomainError(e)) return { ok: false, errorKey: e.messageKey };
    logger.error({ err: e }, "assistant settings save failed");
    return { ok: false, errorKey: "errors.unexpected" };
  }
}

/* --------------------------------------------------------------- tickets */

/**
 * Approve or reject a prepared action.
 *
 * The decision core lives in `tickets.ts` (so the state machine and its permission
 * check are testable without a browser session); this action only supplies the
 * session's facts and revalidates the screen.
 */
export async function decideTicketAction(
  formData: FormData,
): Promise<ActionResult & { status?: string; result?: Record<string, unknown> }> {
  const ctx = await getSessionContext();
  if (!ctx?.tenant || !ctx.userId) return { ok: false, errorKey: "errors.sessionInvalid" };
  const ticketId = String(formData.get("ticketId") ?? "");
  const decision = String(formData.get("decision") ?? "");
  const note = String(formData.get("note") ?? "").trim().slice(0, 500) || null;
  if (!ticketId || (decision !== "approve" && decision !== "reject")) {
    return { ok: false, errorKey: "errors.unexpected" };
  }

  try {
    const tenant = requireOperableTenant(ctx);
    const outcome = await decideTicket({
      tenantId: tenant.id,
      userId: ctx.userId,
      actorLabel: `${ctx.userName} <${ctx.userEmail}>`,
      permissions: ctx.permissions,
      ticketId,
      decision,
      note,
    });
    revalidatePath("/assistant");
    return {
      ok: outcome.ok,
      errorKey: outcome.errorKey,
      okKey: outcome.ok ? (outcome.status === "rejected" ? "ai.ticketRejected" : "ai.ticketExecuted") : undefined,
      status: outcome.status,
      result: outcome.result,
    };
  } catch (e) {
    if (isDomainError(e)) return { ok: false, errorKey: e.messageKey };
    logger.error({ err: e, ticketId }, "ticket decision failed");
    return { ok: false, errorKey: "errors.unexpected" };
  }
}

/** Mark expired proposals as expired, so the list shows only what is actionable. */
export async function expireTicketsAction(): Promise<ActionResult & { expired?: number }> {
  const ctx = await getSessionContext();
  if (!ctx?.tenant || !ctx.userId) return { ok: false, errorKey: "errors.sessionInvalid" };
  try {
    const tenant = requireOperableTenant(ctx);
    const expired = await expireTickets(tenant.id);
    revalidatePath("/assistant");
    return { ok: true, expired };
  } catch (e) {
    if (isDomainError(e)) return { ok: false, errorKey: e.messageKey };
    logger.error({ err: e }, "ticket expiry sweep failed");
    return { ok: false, errorKey: "errors.unexpected" };
  }
}
