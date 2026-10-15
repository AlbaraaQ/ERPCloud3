/**
 * Anthropic-compatible adapter (AI_ASSISTANT §1, D-019).
 *
 * `/v1/messages` with the `tools` + `tool_use` blocks. Same contract as the
 * OpenAI adapter, different wire format — that difference stops here.
 */

import { ProviderError, type ChatMessage, type ChatProvider, type FetchLike, type ToolSpec } from "./types";

export interface AnthropicProviderOptions {
  model: string;
  baseUrl?: string | null;
  apiKey: string;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
  /** required by the API; pinned so a provider change is a deliberate edit */
  anthropicVersion?: string;
}

const DEFAULT_BASE = "https://api.anthropic.com";
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_VERSION = "2023-06-01";

interface AnthropicBlock {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
}

export function createAnthropicProvider(opts: AnthropicProviderOptions): ChatProvider {
  const base = (opts.baseUrl?.trim() || DEFAULT_BASE).replace(/\/+$/, "");
  const doFetch: FetchLike = opts.fetchImpl ?? ((input, init) => fetch(input, init));

  return {
    id: "anthropic",
    model: opts.model,
    async chat({ messages, tools, maxTokens = 900, signal }) {
      // Anthropic takes the system prompt as a top-level field, not a message
      const system = messages
        .filter((m) => m.role === "system")
        .map((m) => m.content)
        .join("\n\n");
      const turns = messages
        .filter((m) => m.role !== "system")
        .map((m: ChatMessage) => {
          if (m.role === "tool") {
            return {
              role: "user",
              content: [{ type: "tool_result", tool_use_id: m.toolCallId ?? m.toolName ?? "tool", content: m.content }],
            };
          }
          if (m.role === "assistant" && m.toolCalls?.length) {
            // Anthropic pairs `tool_use` blocks with the following `tool_result`
            // blocks; dropping the request blocks makes the round trip invalid
            return {
              role: "assistant",
              content: [
                ...(m.content ? [{ type: "text", text: m.content }] : []),
                ...m.toolCalls.map((call) => ({ type: "tool_use", id: call.id, name: call.name, input: call.args ?? {} })),
              ],
            };
          }
          return { role: m.role, content: m.content };
        });

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      const onAbort = () => controller.abort();
      signal?.addEventListener("abort", onAbort, { once: true });

      let response: Response;
      try {
        response = await doFetch(`${base}/v1/messages`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": opts.apiKey,
            "anthropic-version": opts.anthropicVersion ?? DEFAULT_VERSION,
          },
          body: JSON.stringify({
            model: opts.model,
            system: system || undefined,
            messages: turns,
            tools: tools.map((t: ToolSpec) => ({
              name: t.name,
              description: t.description,
              input_schema: t.parameters,
            })),
            max_tokens: maxTokens,
          }),
          signal: controller.signal,
        });
      } catch (e) {
        throw new ProviderError("anthropic", `request failed: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      }

      const raw = await response.text();
      if (!response.ok) {
        throw new ProviderError("anthropic", `HTTP ${response.status}: ${raw.slice(0, 300)}`, response.status);
      }

      let parsed: {
        content?: AnthropicBlock[];
        usage?: { input_tokens?: number; output_tokens?: number };
      };
      try {
        parsed = JSON.parse(raw) as typeof parsed;
      } catch {
        throw new ProviderError("anthropic", "response was not JSON");
      }

      const blocks = parsed.content ?? [];
      const text = blocks
        .filter((b) => b.type === "text")
        .map((b) => b.text ?? "")
        .join("");
      const toolCalls = blocks
        .filter((b) => b.type === "tool_use")
        .map((b, index) => ({ id: b.id ?? `toolu_${index}`, name: b.name ?? "", args: b.input ?? {} }));

      return {
        text,
        toolCalls,
        tokensIn: parsed.usage?.input_tokens ?? 0,
        tokensOut: parsed.usage?.output_tokens ?? 0,
      };
    },
  };
}
