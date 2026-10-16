/**
 * Chat orchestration (AI_ASSISTANT §2, §7).
 *
 * One user turn = one bounded conversation with the provider:
 *
 *   user text → history + system prompt + permitted tool specs → provider
 *      ↳ tool_calls ⇒ registry (permission-checked, zod-validated) ⇒ results
 *      ↳ repeat (max `MAX_ROUNDS`), then the model answers
 *
 * The rules this file exists to hold:
 *  - the model is given the tool *list* it is permitted, and every call is checked
 *    again at execution time — a hallucinated or probed tool is refused with data,
 *    not an exception;
 *  - nothing the model says is trusted: answers are sanitized, tool arguments are
 *    validated, and a proposal never executes — it becomes a ticket for a human;
 *  - every round, refusal and injection hit is recorded; a turn that cannot be
 *    recorded does not happen (availability already refuses read-only tenants);
 *  - an unavailable assistant, a provider failure or an exhausted tool budget all
 *    end in a stated reason in the user's language. Never a blank answer, never a
 *    fabricated figure.
 */

import { and, asc, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { aiApprovalTickets, aiConversations, aiInjectionFlags, aiMessages, aiToolCalls } from "@/db/schema";
import { getDict, type Locale } from "@/i18n/dicts";
import { withTenant, type Trx } from "@/modules/shared/db-context";
import { newId } from "@/modules/shared/ids";
import { logger } from "@/modules/shared/logger";
import { aiAvailability } from "./config";
import { buildSystemPrompt, detectInjection, renderToolData, sanitizeAnswer, wrapUntrusted } from "./guardrails";
import { findIntent, INTENT_KEYS } from "./intents";
import {
  describeProviderError,
  resolveProvider,
  type ChatMessage,
  type ChatProvider,
  type FetchLike,
  type ToolSpec,
} from "./providers";
import { businessToday, runTool, toolSpecsForSession, zodToJsonSchema, type ToolContext } from "./tools";
import { recordAiUsage } from "./usage";

export const MAX_ROUNDS = 3;
export const MAX_TOOL_CALLS_PER_TURN = 6;
export const MAX_MESSAGE_CHARS = 4000;
export const MAX_HISTORY_MESSAGES = 12;
export const TICKET_TTL_HOURS = 24;

/** The one action the model may *prepare*; a human executes tickets later (§4). */
export const PROPOSE_ACTION = "propose_action";

export interface AssistantSession {
  tenantId: string;
  tenantName: string;
  userId: string;
  /** label recorded in the audit trail (name/email — never the password/session) */
  actorLabel: string;
  locale: Locale;
  permissions: ReadonlySet<string>;
}

export interface UsedTool {
  name: string;
  ok: boolean;
  rows: number;
  deniedReason?: string;
  escalation?: boolean;
}

export interface ProposedTicket {
  id: string;
  intent: string;
  titleKey: string;
  requiredPermission: string;
  summary: string;
  expiresAt: string;
}

export interface AskResult {
  ok: boolean;
  conversationId: string | null;
  /** answer text: model text, or the localized system message when `answerKey` is set */
  answer: string;
  /** i18n key when the answer is a system message rather than model output */
  answerKey?: string;
  /** i18n key when the assistant could not serve the turn at all */
  reasonKey?: string;
  usedTools: UsedTool[];
  tickets: ProposedTicket[];
  injectionFlags: number;
  rounds: number;
  model: string | null;
  tokensIn: number;
  tokensOut: number;
}

/** Build the assistant session from a request session (pure — no DB, no cookies). */
export function assistantSessionFrom(
  ctx: {
    tenant: { id: string; name: string } | null;
    userId: string | null;
    userName: string;
    userEmail: string;
    permissions: ReadonlySet<string>;
  },
  locale: Locale,
): AssistantSession {
  if (!ctx.tenant) throw new Error("assistantSessionFrom requires a tenant session");
  return {
    tenantId: ctx.tenant.id,
    tenantName: ctx.tenant.name,
    userId: ctx.userId ?? "",
    actorLabel: `${ctx.userName} <${ctx.userEmail}>`,
    locale,
    permissions: ctx.permissions,
  };
}

export interface AskDeps {
  /** injected in tests: replay a script instead of calling a provider */
  fetchImpl?: FetchLike;
  provider?: ChatProvider;
}

/* ------------------------------------------------------------ helpers */

/** Localized text for an `errors.*` / `ai.*` key, resolved from the pure dict. */
export function messageFor(locale: Locale, key: string): string {
  const dict = getDict(locale) as unknown as Record<string, Record<string, string>>;
  const [group, leaf] = key.split(".");
  return dict[group]?.[leaf] ?? dict.errors?.aiUnavailable ?? "The assistant is unavailable.";
}

function oneLine(text: string, max = 120): string {
  return text.replace(/\s+/g, " ").trim().slice(0, max);
}

/**
 * `intent` is a free string here and is checked against the registry below, for the
 * same reason `runTool` does not trust a tool name: an enum in the schema is a hint
 * to the model, the registry is the boundary. Naming an intent that does not exist
 * is recorded as an escalation, not as a typo.
 */
const proposeSchema = z
  .object({
    intent: z.string().min(3).max(80),
    summary: z.string().min(4).max(300),
    payload: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

const proposeSpec: ToolSpec = {
  name: PROPOSE_ACTION,
  description:
    "Prepare an action for a human to approve. This NEVER executes anything: it files an approval ticket that a user with the required permission approves or rejects in the assistant screen. Allowed intents: " +
    INTENT_KEYS.map((key) => {
      const intent = findIntent(key);
      return `${key} (${intent?.description ?? ""})`;
    }).join(" | "),
  parameters: zodToJsonSchema(proposeSchema),
};

/* ------------------------------------------------ conversation storage */

async function loadConversation(tenantId: string, userId: string, conversationId: string): Promise<boolean> {
  const [row] = await withTenant(tenantId, (trx: Trx) =>
    trx
      .select({ id: aiConversations.id })
      .from(aiConversations)
      .where(
        and(
          eq(aiConversations.id, conversationId),
          eq(aiConversations.tenantId, tenantId),
          eq(aiConversations.userId, userId),
        ),
      )
      .limit(1),
  );
  return Boolean(row);
}

async function createConversation(
  session: AssistantSession,
  title: string,
  conversationId: string,
): Promise<void> {
  await withTenant(session.tenantId, (trx: Trx) =>
    trx.insert(aiConversations).values({
      id: conversationId,
      tenantId: session.tenantId,
      userId: session.userId,
      title: oneLine(title, 200) || null,
      locale: session.locale,
      messageCount: 0,
      lastMessageAt: new Date(),
    }),
  );
}

async function recordMessage(input: {
  tenantId: string;
  conversationId: string;
  role: "user" | "assistant" | "tool" | "system";
  content: string;
  toolName?: string | null;
  model?: string | null;
  tokensIn?: number | null;
  tokensOut?: number | null;
  latencyMs?: number | null;
}): Promise<void> {
  await withTenant(input.tenantId, async (trx: Trx) => {
    await trx.insert(aiMessages).values({
      id: newId(),
      conversationId: input.conversationId,
      tenantId: input.tenantId,
      role: input.role,
      content: input.content,
      toolName: input.toolName ?? null,
      model: input.model ?? null,
      tokensIn: input.tokensIn ?? null,
      tokensOut: input.tokensOut ?? null,
      latencyMs: input.latencyMs ?? null,
    });
    await trx
      .update(aiConversations)
      .set({ messageCount: sql`${aiConversations.messageCount} + 1`, lastMessageAt: new Date() })
      .where(and(eq(aiConversations.id, input.conversationId), eq(aiConversations.tenantId, input.tenantId)));
  });
}

async function loadHistory(tenantId: string, conversationId: string): Promise<ChatMessage[]> {
  const rows = await withTenant(tenantId, (trx: Trx) =>
    trx
      .select({ role: aiMessages.role, content: aiMessages.content })
      .from(aiMessages)
      .where(and(eq(aiMessages.conversationId, conversationId), eq(aiMessages.tenantId, tenantId)))
      .orderBy(desc(aiMessages.at))
      .limit(MAX_HISTORY_MESSAGES),
  );
  return rows
    .reverse()
    .filter((r) => r.role === "user" || r.role === "assistant")
    .map((r) => ({ role: r.role as "user" | "assistant", content: r.content.slice(0, 2000) }));
}

async function flagInjection(input: {
  tenantId: string;
  conversationId: string;
  userId: string;
  source: "user_input" | "tool_output";
  hits: { pattern: string; excerpt: string }[];
}): Promise<number> {
  if (!input.hits.length) return 0;
  await withTenant(input.tenantId, (trx: Trx) =>
    trx.insert(aiInjectionFlags).values(
      input.hits.map((hit) => ({
        id: newId(),
        tenantId: input.tenantId,
        conversationId: input.conversationId,
        userId: input.userId,
        source: input.source,
        pattern: hit.pattern,
        excerpt: hit.excerpt.slice(0, 300),
      })),
    ),
  );
  return input.hits.length;
}

async function recordToolCall(input: {
  tenantId: string;
  conversationId: string;
  userId: string;
  toolName: string;
  args: unknown;
  ok: boolean;
  deniedReason?: string;
  rowsReturned: number;
  escalation?: boolean;
  latencyMs: number;
}): Promise<void> {
  let args: Record<string, unknown> | null = null;
  try {
    // capped: the model may emit a very large blob, and the audit trail must not
    args = JSON.parse(JSON.stringify(input.args ?? {}).slice(0, 4000)) as Record<string, unknown>;
  } catch {
    args = { __unserialisable: true };
  }
  await withTenant(input.tenantId, (trx: Trx) =>
    trx.insert(aiToolCalls).values({
      id: newId(),
      tenantId: input.tenantId,
      conversationId: input.conversationId,
      userId: input.userId,
      toolName: input.toolName,
      args,
      ok: input.ok,
      deniedReason: input.deniedReason ?? null,
      rowsReturned: input.rowsReturned,
      escalationAttempt: Boolean(input.escalation),
      latencyMs: input.latencyMs,
    }),
  );
}

/* ------------------------------------------------------------- the turn */

interface ToolExecution {
  content: string;
  used: UsedTool;
  ticket?: ProposedTicket;
  injections: number;
}

/**
 * Execute one model tool call. Never throws: a refusal is data the model must
 * relay, and it is recorded either way.
 */
async function executeCall(input: {
  session: AssistantSession;
  conversationId: string;
  toolContext: ToolContext;
  name: string;
  args: unknown;
}): Promise<ToolExecution> {
  const { session } = input;
  const started = Date.now();

  if (input.name === PROPOSE_ACTION) {
    const parsed = proposeSchema.safeParse(input.args ?? {});
    if (!parsed.success) {
      const denied = "invalid_arguments";
      await recordToolCall({
        tenantId: session.tenantId,
        conversationId: input.conversationId,
        userId: session.userId,
        toolName: PROPOSE_ACTION,
        args: input.args,
        ok: false,
        deniedReason: denied,
        rowsReturned: 0,
        latencyMs: Date.now() - started,
      });
      return {
        used: { name: PROPOSE_ACTION, ok: false, rows: 0, deniedReason: denied },
        content: renderToolData({
          ok: false,
          error: "invalid proposal",
          issues: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`),
        }),
        injections: 0,
      };
    }

    const intent = findIntent(parsed.data.intent);
    if (!intent) {
      // a made-up intent key is an attempt to reach an action that does not exist
      await recordToolCall({
        tenantId: session.tenantId,
        conversationId: input.conversationId,
        userId: session.userId,
        toolName: PROPOSE_ACTION,
        args: input.args,
        ok: false,
        deniedReason: "unknown_intent",
        rowsReturned: 0,
        escalation: true,
        latencyMs: Date.now() - started,
      });
      return {
        used: { name: PROPOSE_ACTION, ok: false, rows: 0, deniedReason: "unknown_intent", escalation: true },
        content: renderToolData({ ok: false, error: "unknown intent", allowed: INTENT_KEYS }),
        injections: 0,
      };
    }

    const payload = (parsed.data.payload ?? {}) as Record<string, unknown>;
    const checked = intent.schema.safeParse(payload);
    if (!checked.success) {
      await recordToolCall({
        tenantId: session.tenantId,
        conversationId: input.conversationId,
        userId: session.userId,
        toolName: PROPOSE_ACTION,
        args: input.args,
        ok: false,
        deniedReason: "invalid_payload",
        rowsReturned: 0,
        latencyMs: Date.now() - started,
      });
      return {
        used: { name: PROPOSE_ACTION, ok: false, rows: 0, deniedReason: "invalid_payload" },
        content: renderToolData({
          ok: false,
          error: "payload rejected",
          intent: intent.key,
          issues: checked.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`),
        }),
        injections: 0,
      };
    }

    const ticketId = newId();
    const expiresAt = new Date(Date.now() + TICKET_TTL_HOURS * 3600_000);
    const summary = sanitizeAnswer(parsed.data.summary, 300);
    await withTenant(session.tenantId, (trx: Trx) =>
      trx.insert(aiApprovalTickets).values({
        id: ticketId,
        tenantId: session.tenantId,
        conversationId: input.conversationId,
        intent: intent.key,
        payload: checked.data as Record<string, unknown>,
        summary,
        requiredPermission: intent.requiredPermission,
        status: "proposed",
        proposedByUserId: session.userId,
        expiresAt,
      }),
    );
    await recordToolCall({
      tenantId: session.tenantId,
      conversationId: input.conversationId,
      userId: session.userId,
      toolName: PROPOSE_ACTION,
      args: input.args,
      ok: true,
      rowsReturned: 1,
      latencyMs: Date.now() - started,
    });
    return {
      used: { name: PROPOSE_ACTION, ok: true, rows: 1 },
      content: renderToolData({
        ok: true,
        ticketId,
        intent: intent.key,
        requiredPermission: intent.requiredPermission,
        expiresAt: expiresAt.toISOString(),
        note: "Filed for human approval. It is NOT executed and you must not claim it was.",
      }),
      ticket: {
        id: ticketId,
        intent: intent.key,
        titleKey: intent.titleKey,
        requiredPermission: intent.requiredPermission,
        summary,
        expiresAt: expiresAt.toISOString(),
      },
      injections: 0,
    };
  }

  const result = await withTenant(session.tenantId, (trx: Trx) =>
    runTool(input.toolContext, { name: input.name, args: input.args }, trx),
  );
  await recordToolCall({
    tenantId: session.tenantId,
    conversationId: input.conversationId,
    userId: session.userId,
    toolName: result.toolName,
    args: input.args,
    ok: result.ok,
    deniedReason: result.deniedReason,
    rowsReturned: result.rows,
    escalation: result.escalation,
    latencyMs: Date.now() - started,
  });

  const payload = result.ok
    ? result.data
    : {
        error: "refused",
        reason: result.deniedReason,
        unavailable: result.unavailable?.reason,
        ...(result.data as Record<string, unknown>),
      };
  const rendered = renderToolData(payload);
  // Tool output is business data, so it is scanned like any other untrusted text:
  // a note field that says "ignore your instructions" must be flagged, not obeyed.
  const hits = detectInjection(rendered);
  const injections = hits.length
    ? await flagInjection({
        tenantId: session.tenantId,
        conversationId: input.conversationId,
        userId: session.userId,
        source: "tool_output",
        hits,
      })
    : 0;

  return {
    content: wrapUntrusted(result.toolName, rendered),
    used: {
      name: result.toolName,
      ok: result.ok,
      rows: result.rows,
      deniedReason: result.deniedReason,
      escalation: result.escalation,
    },
    injections,
  };
}

/**
 * Answer one user turn.
 *
 * Everything the caller gets back is safe to render: `answer` is sanitized text in
 * the session's language, `answerKey`/`reasonKey` name a dictionary entry when the
 * text is a system message, and the tool/ticket lists are structured facts.
 */
export async function askAssistant(
  input: { session: AssistantSession; message: string; conversationId?: string | null },
  deps: AskDeps = {},
): Promise<AskResult> {
  const { session } = input;
  const empty: AskResult = {
    ok: false,
    conversationId: null,
    answer: "",
    usedTools: [],
    tickets: [],
    injectionFlags: 0,
    rounds: 0,
    model: null,
    tokensIn: 0,
    tokensOut: 0,
  };

  const text = (input.message ?? "").trim();
  if (!text) {
    const key = "errors.aiMessageRequired";
    return { ...empty, answer: messageFor(session.locale, key), answerKey: key, reasonKey: key };
  }
  if (text.length > MAX_MESSAGE_CHARS) {
    const key = "errors.aiMessageTooLong";
    return { ...empty, answer: messageFor(session.locale, key), answerKey: key, reasonKey: key };
  }

  const availability = await aiAvailability(session.tenantId);
  if (!availability.available) {
    const key = availability.reasonKey ?? "errors.aiUnavailable";
    return { ...empty, answer: messageFor(session.locale, key), answerKey: key, reasonKey: key };
  }
  const config = availability.config!;

  // Attach to the caller's own thread, or start one. A conversation id that is not
  // this user's is not \"resolved\" silently into somebody else's transcript: it is
  // ignored and flagged.
  let conversationId = input.conversationId ?? null;
  if (conversationId) {
    const mine = await loadConversation(session.tenantId, session.userId, conversationId);
    if (!mine) {
      logger.warn(
        { tenantId: session.tenantId, userId: session.userId, conversationId },
        "assistant conversation id did not belong to the session; starting a new thread",
      );
      conversationId = null;
    }
  }
  if (!conversationId) {
    conversationId = newId();
    await createConversation(session, text, conversationId);
  }

  let injectionFlags = 0;
  await recordMessage({
    tenantId: session.tenantId,
    conversationId,
    role: "user",
    content: text,
  });
  injectionFlags += await flagInjection({
    tenantId: session.tenantId,
    conversationId,
    userId: session.userId,
    source: "user_input",
    hits: detectInjection(text),
  });

  const provider =
    deps.provider ??
    resolveProvider(
      { provider: config.provider, model: config.model, baseUrl: config.baseUrl, secretRef: config.secretRef },
      { fetchImpl: deps.fetchImpl },
    );

  const toolContext: ToolContext = {
    tenantId: session.tenantId,
    userId: session.userId,
    permissions: session.permissions,
    dataScope: config.dataScope,
    locale: session.locale,
    today: businessToday(),
  };

  const tools: ToolSpec[] = [...toolSpecsForSession(session.permissions), proposeSpec];
  const history = await loadHistory(session.tenantId, conversationId);
  const messages: ChatMessage[] = [
    {
      role: "system",
      content: buildSystemPrompt({
        tenantName: session.tenantName,
        userName: session.actorLabel,
        locale: session.locale,
        tools: tools.map((t) => t.name),
        dataScope: config.dataScope,
        today: toolContext.today,
      }),
    },
    ...history,
    { role: "user", content: text },
  ];

  const usedTools: UsedTool[] = [];
  const tickets: ProposedTicket[] = [];
  let tokensIn = 0;
  let tokensOut = 0;
  let rounds = 0;
  let answer: string | null = null;
  let answerKey: string | undefined;

  while (rounds < MAX_ROUNDS) {
    rounds += 1;
    const started = Date.now();
    let reply;
    try {
      reply = await provider.chat({ messages, tools, maxTokens: 1200 });
    } catch (e) {
      // provider outages are not the user's fault and not their data problem: the
      // detail goes to the log (never the answer, never with the request body)
      logger.warn(
        { tenantId: session.tenantId, conversationId, provider: provider.id, err: describeProviderError(e) },
        "assistant provider call failed",
      );
      const key = "errors.aiUnavailable";
      answer = messageFor(session.locale, key);
      answerKey = key;
      break;
    }
    const latency = Date.now() - started;
    tokensIn += reply.tokensIn;
    tokensOut += reply.tokensOut;

    const modelText = sanitizeAnswer(reply.text ?? "");
    await recordMessage({
      tenantId: session.tenantId,
      conversationId,
      role: "assistant",
      content: modelText,
      toolName: reply.toolCalls[0]?.name ?? null,
      model: `${provider.id}:${provider.model}`,
      tokensIn: reply.tokensIn,
      tokensOut: reply.tokensOut,
      latencyMs: latency,
    });

    if (!reply.toolCalls.length) {
      answer = modelText || messageFor(session.locale, "errors.aiNoAnswer");
      if (!modelText) answerKey = "errors.aiNoAnswer";
      break;
    }

    const calls = reply.toolCalls.slice(0, MAX_TOOL_CALLS_PER_TURN);
    const dropped = reply.toolCalls.length - calls.length;
    messages.push({ role: "assistant", content: modelText, toolCalls: calls });

    for (const call of calls) {
      const execution = await executeCall({
        session,
        conversationId,
        toolContext,
        name: call.name,
        args: call.args,
      });
      usedTools.push(execution.used);
      injectionFlags += execution.injections;
      if (execution.ticket) tickets.push(execution.ticket);
      messages.push({
        role: "tool",
        toolName: call.name,
        toolCallId: call.id,
        content: execution.content,
      });
    }

    if (dropped > 0) {
      // the budget is a hard cap; the extra calls are recorded as refusals so the
      // audit shows what the model wanted, not only what it got
      for (const call of reply.toolCalls.slice(calls.length)) {
        await recordToolCall({
          tenantId: session.tenantId,
          conversationId,
          userId: session.userId,
          toolName: call.name,
          args: call.args,
          ok: false,
          deniedReason: "tool_budget_exceeded",
          rowsReturned: 0,
          latencyMs: 0,
        });
        usedTools.push({ name: call.name, ok: false, rows: 0, deniedReason: "tool_budget_exceeded" });
      }
    }

    if (rounds >= MAX_ROUNDS) {
      // it kept asking for tools: state that plainly instead of dumping tool data
      // into an \"answer\" the model never produced
      answerKey = "errors.aiToolsExhausted";
      answer = messageFor(session.locale, answerKey);
    }
  }

  // Counters for the platform console: how much the assistant is used, never what
  // it was asked or answered (AI_ASSISTANT §7). Metering cannot fail the answer.
  await recordAiUsage(session.tenantId, {
    turns: rounds > 0 ? 1 : 0,
    tokensIn,
    tokensOut,
    toolCalls: usedTools.length,
    refusals: usedTools.filter((tool) => !tool.ok).length,
    injectionFlags,
  });

  return {
    ok: Boolean(answer) && !answerKey,
    conversationId,
    answer: answer ?? messageFor(session.locale, "errors.aiUnavailable"),
    answerKey,
    usedTools,
    tickets,
    injectionFlags,
    rounds,
    model: `${provider.id}:${provider.model}`,
    tokensIn,
    tokensOut,
  };
}

/** Threads for the assistant screen (own threads only). */
export async function listConversations(session: AssistantSession, limit = 20) {
  return withTenant(session.tenantId, (trx: Trx) =>
    trx
      .select({
        id: aiConversations.id,
        title: aiConversations.title,
        messageCount: aiConversations.messageCount,
        lastMessageAt: aiConversations.lastMessageAt,
      })
      .from(aiConversations)
      .where(and(eq(aiConversations.tenantId, session.tenantId), eq(aiConversations.userId, session.userId)))
      .orderBy(desc(aiConversations.lastMessageAt))
      .limit(limit),
  );
}

/** Transcript of one own thread. */
export async function loadTranscript(session: AssistantSession, conversationId: string, limit = 50) {
  const mine = await loadConversation(session.tenantId, session.userId, conversationId);
  if (!mine) return null;
  const rows = await withTenant(session.tenantId, (trx: Trx) =>
    trx
      .select({
        id: aiMessages.id,
        role: aiMessages.role,
        content: aiMessages.content,
        toolName: aiMessages.toolName,
        model: aiMessages.model,
        at: aiMessages.at,
      })
      .from(aiMessages)
      .where(and(eq(aiMessages.conversationId, conversationId), eq(aiMessages.tenantId, session.tenantId)))
      .orderBy(asc(aiMessages.at))
      .limit(limit),
  );
  return rows;
}

/** Tickets awaiting a decision, and the caller's own recent ones. */
export async function listTickets(session: AssistantSession, limit = 20) {
  return withTenant(session.tenantId, (trx: Trx) =>
    trx
      .select({
        id: aiApprovalTickets.id,
        intent: aiApprovalTickets.intent,
        summary: aiApprovalTickets.summary,
        requiredPermission: aiApprovalTickets.requiredPermission,
        status: aiApprovalTickets.status,
        expiresAt: aiApprovalTickets.expiresAt,
        createdAt: aiApprovalTickets.createdAt,
        decidedByUserId: aiApprovalTickets.decidedByUserId,
        executedAt: aiApprovalTickets.executedAt,
        result: aiApprovalTickets.result,
      })
      .from(aiApprovalTickets)
      .where(eq(aiApprovalTickets.tenantId, session.tenantId))
      .orderBy(desc(aiApprovalTickets.createdAt))
      .limit(limit),
  );
}
