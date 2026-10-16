"use client";

/**
 * Assistant chat + approval inbox (AI_ASSISTANT §2, §4).
 *
 * Client-side rules:
 *  - the answer text is rendered as plain text (`whitespace-pre-wrap`), never as
 *    HTML: model output is untrusted content (§6);
 *  - the tool chips are facts returned by the server, so a reader can see which
 *    report produced a number without trusting the prose;
 *  - a proposal is a *card with buttons*, never a claim: approving runs the server
 *    action, which re-checks the permission and executes through the services.
 *
 * Types are declared here rather than imported from the server module, so nothing
 * of the AI backend can end up in the browser bundle.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { AlertTriangle, Check, Play, Send, ShieldAlert, Sparkles, Wrench, X } from "lucide-react";
import { askAiAction, decideTicketAction } from "@/modules/ai/actions";

interface AiLabels {
  title: string;
  subtitle: string;
  unavailableTitle: string;
  placeholder: string;
  send: string;
  thinking: string;
  empty: string;
  you: string;
  assistant: string;
  toolsTitle: string;
  toolDenied: string;
  toolRows: string;
  noTools: string;
  injectionNotice: string;
  ticketsTitle: string;
  ticketsHint: string;
  noTickets: string;
  assistantSuggestion: string;
  requiredPermission: string;
  expiresAt: string;
  approve: string;
  reject: string;
  approveConfirm: string;
  rejectConfirm: string;
  statusProposed: string;
  statusApproved: string;
  statusRejected: string;
  statusExecuted: string;
  statusExpired: string;
  resultExecuted: string;
  settingsTitle: string;
  noAccess: string;
  scopeMasked: string;
  scopeNames: string;
  daysShort: string;
  dataScopeMetrics: string;
  dataScopeNames: string;
}

interface UsedToolView {
  name: string;
  ok: boolean;
  rows: number;
  deniedReason?: string;
}

interface TicketView {
  id: string;
  intent: string;
  intentKey: string;
  summary: string;
  requiredPermission: string;
  status: string;
  expiresAt: string;
  result: Record<string, unknown> | null;
  canDecide: boolean;
}

interface MessageView {
  id: string;
  role: string;
  content: string;
  toolName: string | null;
  at: string;
}

interface Props {
  t: AiLabels;
  errors: Record<string, string>;
  locale: "ar" | "en";
  available: boolean;
  reasonKey: string | null;
  reasonText: string | null;
  conversationId: string | null;
  messages: MessageView[];
  tickets: TicketView[];
  canSeeSettings: boolean;
  model: string | null;
  dataScope: "metrics_only" | "names_allowed";
  retentionDays: number;
}

function errorText(errors: Record<string, string>, key?: string | null): string {
  const leaf = (key ?? "").split(".")[1] ?? "unexpected";
  return errors[leaf] ?? errors.unexpected ?? "";
}

function ticketLabel(t: AiLabels, intentKey: string): string {
  if (intentKey.startsWith("ai.")) {
    const leaf = intentKey.split(".")[1] as keyof AiLabels | undefined;
    const value = leaf ? t[leaf] : undefined;
    if (typeof value === "string") return value;
  }
  return intentKey;
}

function statusLabel(t: AiLabels, status: string): string {
  switch (status) {
    case "proposed":
      return t.statusProposed;
    case "approved":
      return t.statusApproved;
    case "rejected":
      return t.statusRejected;
    case "executed":
      return t.statusExecuted;
    case "expired":
      return t.statusExpired;
    default:
      return status;
  }
}

const STATUS_TONE: Record<string, string> = {
  proposed: "bg-warning-soft text-warning",
  approved: "bg-primary-soft text-primary",
  executed: "bg-success-soft text-success",
  rejected: "bg-danger-soft text-danger",
  expired: "bg-surface-3 text-muted",
};

function TicketCard({
  t,
  errors,
  ticket,
  onDecided,
  compact,
}: {
  t: AiLabels;
  errors: Record<string, string>;
  ticket: TicketView;
  onDecided: (ticketId: string, status: string, errorKey?: string) => void;
  compact?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const actionable = ticket.status === "proposed" && ticket.canDecide;

  async function decide(decision: "approve" | "reject") {
    const confirmText = decision === "approve" ? t.approveConfirm : t.rejectConfirm;
    if (!window.confirm(confirmText)) return;
    setBusy(true);
    try {
      const fd = new FormData();
      fd.set("ticketId", ticket.id);
      fd.set("decision", decision);
      const res = await decideTicketAction(fd);
      onDecided(ticket.id, res.status ?? ticket.status, res.ok ? undefined : res.errorKey);
    } catch {
      onDecided(ticket.id, ticket.status, "errors.unexpected");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`card p-3 ${compact ? "mt-2" : ""} border-border`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-primary" aria-hidden />
          <span className="text-sm font-semibold">{ticketLabel(t, ticket.intentKey)}</span>
        </div>
        <span className={`rounded-md px-2 py-0.5 text-[11px] font-semibold ${STATUS_TONE[ticket.status] ?? STATUS_TONE.expired}`}>
          {statusLabel(t, ticket.status)}
        </span>
      </div>

      {ticket.summary ? (
        <p className="mt-2 text-xs text-muted">
          <span className="font-semibold">{t.assistantSuggestion}: </span>
          {ticket.summary}
        </p>
      ) : null}

      <dl className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-[11px] text-muted">
        <div className="flex gap-1">
          <dt>{t.requiredPermission}:</dt>
          <dd className="font-mono" dir="ltr">
            {ticket.requiredPermission}
          </dd>
        </div>
        <div className="flex gap-1">
          <dt>{t.expiresAt}:</dt>
          <dd className="tnum" dir="ltr">
            {new Date(ticket.expiresAt).toISOString().slice(0, 16).replace("T", " ")}
          </dd>
        </div>
      </dl>

      {ticket.status === "executed" && ticket.result ? (
        <p className="mt-2 flex items-center gap-1 text-xs text-success">
          <Check className="h-3.5 w-3.5" aria-hidden />
          {t.resultExecuted}: <span className="font-mono" dir="ltr">{JSON.stringify(ticket.result)}</span>
        </p>
      ) : null}

      {ticket.status === "proposed" && !ticket.canDecide ? (
        <p className="mt-2 flex items-center gap-1 text-[11px] text-muted">
          <ShieldAlert className="h-3.5 w-3.5" aria-hidden />
          {errors.permissionDenied}
        </p>
      ) : null}

      {actionable ? (
        <div className="mt-3 flex flex-wrap gap-2">
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => decide("approve")}>
            <Play className="h-4 w-4 rtl:-scale-x-100" aria-hidden />
            {t.approve}
          </button>
          <button type="button" className="btn btn-ghost text-danger" disabled={busy} onClick={() => decide("reject")}>
            <X className="h-4 w-4" aria-hidden />
            {t.reject}
          </button>
        </div>
      ) : null}
    </div>
  );
}

export function AssistantScreen(props: Props) {
  const { t, errors, locale } = props;
  const router = useRouter();
  const [messages, setMessages] = useState<MessageView[]>(props.messages);
  const [tickets, setTickets] = useState<TicketView[]>(props.tickets);
  const [conversationId, setConversationId] = useState<string | null>(props.conversationId);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  // tools + tickets of the *latest* answer, so each bubble keeps its own facts
  const [turnTools, setTurnTools] = useState<Record<string, UsedToolView[]>>({});
  const [turnTickets, setTurnTickets] = useState<Record<string, TicketView[]>>({});

  async function send() {
    const message = draft.trim();
    if (!message || pending) return;
    setPending(true);
    setNotice(null);
    const localId = `local-${Date.now()}`;
    setMessages((prev) => [
      ...prev,
      { id: `${localId}-u`, role: "user", content: message, toolName: null, at: new Date().toISOString() },
    ]);
    setDraft("");
    try {
      const res = await askAiAction({ message, conversationId });
      const answerId = `${localId}-a`;
      setMessages((prev) => [
        ...prev,
        {
          id: answerId,
          role: "assistant",
          content: res.answer,
          toolName: null,
          at: new Date().toISOString(),
        },
      ]);
      setTurnTools((prev) => ({ ...prev, [answerId]: (res.usedTools ?? []) as UsedToolView[] }));
      const proposed = (res.tickets ?? []) as unknown as TicketView[];
      if (proposed.length) {
        const views = proposed.map((p) => ({
          ...p,
          status: "proposed",
          result: null,
          canDecide: true,
        }));
        setTurnTickets((prev) => ({ ...prev, [answerId]: views }));
        setTickets((prev) => [...views, ...prev]);
      }
      if (res.conversationId) setConversationId(res.conversationId);
      if (!res.ok) setNotice({ ok: false, text: res.answer });
      if (res.injectionFlags > 0) setNotice({ ok: false, text: t.injectionNotice });
    } catch {
      setMessages((prev) => [
        ...prev,
        { id: `${localId}-e`, role: "assistant", content: errorText(errors), toolName: null, at: new Date().toISOString() },
      ]);
      setNotice({ ok: false, text: errorText(errors) });
    } finally {
      setPending(false);
      router.refresh();
    }
  }

  /** Reflect a decision locally, and resync from the server (the ticket is the truth). */
  function onDecided(ticketId: string, status: string, errorKey?: string) {
    const settle = (list: TicketView[]) =>
      list.map((item) => (item.id === ticketId ? { ...item, status, result: item.result } : item));
    setTickets(settle);
    setTurnTickets((prev) => Object.fromEntries(Object.entries(prev).map(([k, v]) => [k, settle(v)])));
    if (errorKey) {
      setNotice({ ok: false, text: errorText(errors, errorKey) });
    } else {
      setNotice({ ok: true, text: statusLabel(t, status) });
    }
    router.refresh();
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold">
            <Sparkles className="h-6 w-6 text-primary" aria-hidden />
            {t.title}
          </h1>
          <p className="mt-1 text-sm text-muted">{t.subtitle}</p>
        </div>
        <div className="flex items-center gap-2">
          {props.model ? (
            <span className="rounded-md bg-surface-3 px-2 py-1 font-mono text-[11px] text-muted" dir="ltr">
              {props.model}
            </span>
          ) : null}
          <span
            className="rounded-md bg-surface-3 px-2 py-1 text-[11px] text-muted"
            title={props.dataScope === "names_allowed" ? t.dataScopeNames : t.dataScopeMetrics}
          >
            {props.dataScope === "names_allowed" ? t.scopeNames : t.scopeMasked} · {props.retentionDays}{" "}
            {t.daysShort}
          </span>
          {props.canSeeSettings ? (
            <Link href="/assistant/settings" className="btn btn-ghost">
              {t.settingsTitle}
            </Link>
          ) : null}
        </div>
      </header>

      {!props.available ? (
        <section className="card border-warning/40 p-4" role="status">
          <h2 className="flex items-center gap-2 text-sm font-bold text-warning">
            <AlertTriangle className="h-4 w-4" aria-hidden />
            {t.unavailableTitle}
          </h2>
          <p className="mt-2 text-sm text-muted">{props.reasonText ?? errorText(errors, props.reasonKey)}</p>
          {!props.canSeeSettings ? <p className="mt-1 text-xs text-muted">{t.noAccess}</p> : null}
        </section>
      ) : null}

      {notice ? (
        <p
          role={notice.ok ? "status" : "alert"}
          className={`card p-3 text-sm ${notice.ok ? "border-success/40 text-success" : "border-danger/40 text-danger"}`}
        >
          {notice.text}
        </p>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
        <section className="card flex min-h-[60vh] flex-col p-4">
          <div
            className="flex-1 space-y-4 overflow-y-auto pe-1"
            role="log"
            aria-live="polite"
            aria-busy={pending}
            aria-label={t.title}
          >
            {messages.length === 0 ? <p className="text-sm text-muted">{t.empty}</p> : null}
            {messages.map((m) => (
              <div key={m.id} className={m.role === "user" ? "text-end" : ""}>
                <p className="mb-1 text-[11px] font-semibold text-muted">
                  {m.role === "user" ? t.you : t.assistant}
                </p>
                <div
                  className={`inline-block max-w-full whitespace-pre-wrap rounded-xl px-3 py-2 text-sm ${
                    m.role === "user" ? "bg-primary-soft text-foreground" : "bg-surface-2"
                  }`}
                  dir={locale === "ar" ? "rtl" : "ltr"}
                >
                  {m.content}
                </div>

                {turnTools[m.id]?.length ? (
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <span className="flex items-center gap-1 text-[11px] font-semibold text-muted">
                      <Wrench className="h-3.5 w-3.5" aria-hidden />
                      {t.toolsTitle}:
                    </span>
                    {turnTools[m.id].map((tool, index) => (
                      <span
                        key={`${tool.name}-${index}`}
                        className={`rounded-md px-2 py-0.5 text-[11px] font-medium ${
                          tool.ok ? "bg-surface-3 text-foreground/80" : "bg-danger-soft text-danger"
                        }`}
                        dir="ltr"
                      >
                        {tool.name}
                        {tool.ok ? ` · ${t.toolRows} ${tool.rows}` : ` · ${t.toolDenied}`}
                      </span>
                    ))}
                  </div>
                ) : null}

                {turnTickets[m.id]?.map((ticket) => (
                  <TicketCard
                    key={ticket.id}
                    t={t}
                    errors={errors}
                    ticket={ticket}
                    onDecided={onDecided}
                    compact
                  />
                ))}
              </div>
            ))}
            {pending ? (
              <p className="text-sm text-muted" role="status">
                {t.thinking}
              </p>
            ) : null}
          </div>

          <div className="mt-4 flex items-end gap-2 border-t border-border pt-4">
            <textarea
              className="input min-h-[2.75rem] flex-1 resize-y"
              rows={2}
              aria-label={t.placeholder}
              placeholder={t.placeholder}
              value={draft}
              disabled={!props.available || pending}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
            />
            <button
              type="button"
              className="btn btn-primary"
              disabled={!props.available || pending || !draft.trim()}
              onClick={() => void send()}
            >
              <Send className="h-4 w-4 rtl:-scale-x-100" aria-hidden />
              {t.send}
            </button>
          </div>
        </section>

        <aside className="space-y-3">
          <section className="card p-4">
            <h2 className="text-sm font-bold">{t.ticketsTitle}</h2>
            <p className="mt-1 text-[11px] text-muted">{t.ticketsHint}</p>
          </section>
          {tickets.length === 0 ? (
            <p className="text-sm text-muted">{t.noTickets}</p>
          ) : (
            tickets.map((ticket) => (
              <TicketCard key={ticket.id} t={t} errors={errors} ticket={ticket} onDecided={onDecided} />
            ))
          )}
        </aside>
      </div>
    </div>
  );
}

export type { TicketView, MessageView, UsedToolView };
