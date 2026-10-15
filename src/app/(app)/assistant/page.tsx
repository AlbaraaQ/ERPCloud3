/**
 * Assistant screen (AI_ASSISTANT §2, §4).
 *
 * The server renders the thread, the tickets and the availability reason; the
 * client component drives one turn at a time through `askAiAction`. Nothing about
 * the model, the key or the conversation SQL reaches the browser — the client sees
 * an answer, the tools that produced it, and the tickets awaiting a human.
 */

import { redirect } from "next/navigation";
import { getSessionContext } from "@/modules/identity/auth";
import { getLocale, getDict } from "@/i18n";
import { aiAvailability } from "@/modules/ai/config";
import { assistantSessionFrom, listConversations, listTickets, loadTranscript } from "@/modules/ai/chat";
import { AssistantScreen, type TicketView } from "./assistant-screen";

export const dynamic = "force-dynamic";

export default async function AssistantPage() {
  const ctx = await getSessionContext();
  if (!ctx || !ctx.tenant || !ctx.userId) redirect("/login");

  const locale = await getLocale();
  const t = getDict(locale);
  const errors = t.errors as unknown as Record<string, string>;
  const session = assistantSessionFrom(ctx, locale);

  const availability = await aiAvailability(session.tenantId);
  const canSeeSettings = ctx.permissions.has("settings.company.manage");

  // Threads/tickets are only read when the assistant is available; when it is off
  // the screen explains why instead of showing stale data as if it were live.
  let conversationId: string | null = null;
  let transcript: Awaited<ReturnType<typeof loadTranscript>> = [];
  let tickets: Awaited<ReturnType<typeof listTickets>> = [];
  if (availability.available) {
    conversationId = (await listConversations(session, 5))[0]?.id ?? null;
    transcript = conversationId ? await loadTranscript(session, conversationId, 50) : [];
    tickets = await listTickets(session, 20);
  }

  const ticketViews: TicketView[] = (tickets ?? []).map((ticket) => ({
    id: ticket.id,
    intent: ticket.intent,
    intentKey: ticketIntentKey(ticket.intent),
    summary: ticket.summary ?? "",
    requiredPermission: ticket.requiredPermission,
    status: ticket.status,
    expiresAt: ticket.expiresAt.toISOString(),
    result: (ticket.result ?? null) as Record<string, unknown> | null,
    canDecide: ctx.permissions.has(ticket.requiredPermission),
  }));

  const reasonKey = availability.reasonKey ?? null;

  return (
    <AssistantScreen
      t={t.ai}
      errors={errors}
      locale={locale}
      available={availability.available}
      reasonKey={reasonKey}
      reasonText={reasonKey ? (errors[reasonKey.split(".")[1] ?? "aiUnavailable"] ?? errors.aiUnavailable) : null}
      conversationId={conversationId}
      messages={(transcript ?? []).map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        toolName: m.toolName ?? null,
        at: m.at.toISOString(),
      }))}
      tickets={ticketViews}
      canSeeSettings={canSeeSettings}
      model={availability.config?.model ?? null}
      dataScope={availability.config?.dataScope ?? "metrics_only"}
      retentionDays={availability.config?.retentionDays ?? 30}
    />
  );
}

/** Label key for a registered intent (`ai_approval_tickets.intent`). */
function ticketIntentKey(intent: string): string {
  if (intent === "journal_entry_draft") return "ai.intentJournalDraft";
  if (intent === "tenant_export") return "ai.intentTenantExport";
  return intent;
}
