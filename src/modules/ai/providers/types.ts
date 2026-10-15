/**
 * Provider contract for the assistant (AI_ASSISTANT §1, D-019).
 *
 * The core never imports a vendor SDK: it talks to this interface, and the
 * adapters are plain `fetch` calls against base URLs. That keeps provider code
 * swappable, testable without a network, and impossible to reach from the
 * accounting engine.
 */

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema for the arguments (derived from the tool's zod schema). */
  parameters: Record<string, unknown>;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** set for role: "tool" — which tool produced this content */
  toolName?: string;
  /** provider-side correlation id for a tool result */
  toolCallId?: string;
  /**
   * set for role: "assistant" when that turn requested tools. Both provider APIs
   * *require* the request and its results to be paired (`tool_calls` followed by
   * `tool` messages, `tool_use` followed by `tool_result`), so the round trip has
   * to carry them; without this the second round is an invalid conversation.
   */
  toolCalls?: ModelToolCall[];
}

export interface ModelToolCall {
  id: string;
  name: string;
  /** raw arguments as the provider returned them (validated by the caller) */
  args: unknown;
}

export interface ModelReply {
  text: string;
  toolCalls: ModelToolCall[];
  tokensIn: number;
  tokensOut: number;
}

export interface ChatProvider {
  /** adapter id, recorded in the audit trail ("openai" | "anthropic" | …) */
  readonly id: string;
  readonly model: string;
  chat(input: {
    messages: ChatMessage[];
    tools: ToolSpec[];
    /** hard cap on generated tokens — the assistant answers, it does not write essays */
    maxTokens?: number;
    signal?: AbortSignal;
  }): Promise<ModelReply>;
}

/** Injected for tests: a provider that replays a script instead of calling out. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class ProviderError extends Error {
  readonly providerId: string;
  readonly status?: number;
  constructor(providerId: string, message: string, status?: number) {
    super(message);
    this.name = "ProviderError";
    this.providerId = providerId;
    this.status = status;
  }
}
