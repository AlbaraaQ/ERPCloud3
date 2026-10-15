/**
 * OpenAI-compatible adapter (AI_ASSISTANT §1, D-019).
 *
 * Covers OpenAI, Azure OpenAI, OpenRouter, vLLM, Ollama and anything else that
 * speaks `/chat/completions` — the only difference is the base URL and the key,
 * which come from configuration (never from source control, never from the
 * browser). Tool calls use the standard `tools` + `tool_calls` shape.
 */

import { ProviderError, type ChatMessage, type ChatProvider, type FetchLike, type ToolSpec } from "./types";

interface OpenAiToolCall {
  id?: string;
  function?: { name?: string; arguments?: string };
}

export interface OpenAiProviderOptions {
  model: string;
  baseUrl?: string | null;
  apiKey: string;
  /** default 60 s — an assistant that hangs must not hold a request open */
  timeoutMs?: number;
  fetchImpl?: FetchLike;
  /** extra headers for Azure-style deployments */
  headers?: Record<string, string>;
}

const DEFAULT_BASE = "https://api.openai.com/v1";
const DEFAULT_TIMEOUT_MS = 60_000;

function toOpenAiMessages(messages: ChatMessage[]): unknown[] {
  return messages.map((m) => {
    if (m.role === "tool") {
      return { role: "tool", tool_call_id: m.toolCallId ?? m.toolName ?? "tool", content: m.content };
    }
    if (m.role === "assistant" && m.toolCalls?.length) {
      // the API rejects `tool` messages that do not answer an assistant turn
      // carrying `tool_calls`, so the request is replayed exactly as it came
      return {
        role: "assistant",
        content: m.content || null,
        tool_calls: m.toolCalls.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) },
        })),
      };
    }
    return { role: m.role, content: m.content };
  });
}

export function createOpenAiProvider(opts: OpenAiProviderOptions): ChatProvider {
  const base = (opts.baseUrl?.trim() || DEFAULT_BASE).replace(/\/+$/, "");
  const doFetch: FetchLike = opts.fetchImpl ?? ((input, init) => fetch(input, init));

  return {
    id: "openai",
    model: opts.model,
    async chat({ messages, tools, maxTokens = 900, signal }) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      const onAbort = () => controller.abort();
      signal?.addEventListener("abort", onAbort, { once: true });

      let response: Response;
      try {
        response = await doFetch(`${base}/chat/completions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${opts.apiKey}`,
            ...(opts.headers ?? {}),
          },
          body: JSON.stringify({
            model: opts.model,
            messages: toOpenAiMessages(messages),
            tools: tools.map((t: ToolSpec) => ({
              type: "function",
              function: { name: t.name, description: t.description, parameters: t.parameters },
            })),
            tool_choice: tools.length > 0 ? "auto" : undefined,
            max_tokens: maxTokens,
          }),
          signal: controller.signal,
        });
      } catch (e) {
        throw new ProviderError("openai", `request failed: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      }

      const text = await response.text();
      if (!response.ok) {
        // the body may echo the request; keep only a short, non-secret excerpt
        throw new ProviderError("openai", `HTTP ${response.status}: ${text.slice(0, 300)}`, response.status);
      }

      let parsed: {
        choices?: { message?: { content?: string | null; tool_calls?: OpenAiToolCall[] } }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      try {
        parsed = JSON.parse(text) as typeof parsed;
      } catch {
        throw new ProviderError("openai", "response was not JSON");
      }

      const message = parsed.choices?.[0]?.message ?? {};
      const toolCalls = (message.tool_calls ?? []).map((call, index) => {
        let args: unknown = {};
        try {
          args = call.function?.arguments ? JSON.parse(call.function.arguments) : {};
        } catch {
          // a model that emits invalid JSON for arguments is a model bug, not a
          // reason to execute anything: the registry rejects it as unknown input
          args = { __invalidJson: call.function?.arguments ?? "" };
        }
        return { id: call.id ?? `call_${index}`, name: call.function?.name ?? "", args };
      });

      return {
        text: message.content ?? "",
        toolCalls,
        tokensIn: parsed.usage?.prompt_tokens ?? 0,
        tokensOut: parsed.usage?.completion_tokens ?? 0,
      };
    },
  };
}
