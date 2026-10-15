/**
 * Provider registry (AI_ASSISTANT §1).
 *
 * Adapters are constructed from configuration only. Keys are read from the
 * environment by NAME (the config row stores `secretRef`, never a key), so a
 * database dump cannot leak one and a key rotation needs no data change.
 */

import { errors } from "@/modules/shared/result";
import { logger } from "@/modules/shared/logger";
import { createAnthropicProvider } from "./anthropic";
import { createOpenAiProvider } from "./openai";
import { ProviderError, type ChatProvider, type FetchLike } from "./types";

export type { ChatProvider, ChatMessage, ModelReply, ModelToolCall, ToolSpec, FetchLike } from "./types";
export { ProviderError } from "./types";

export const PROVIDER_IDS = ["openai", "anthropic"] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export interface ProviderConfig {
  provider: string;
  model: string;
  baseUrl?: string | null;
  /** NAME of the environment variable holding the API key. */
  secretRef?: string | null;
}

export function providerKeyPresent(secretRef: string | null | undefined): boolean {
  if (!secretRef) return false;
  return Boolean(process.env[secretRef]);
}

/**
 * Build the adapter for a tenant's configuration.
 *
 * Throws `errors.aiNotConfigured` (a configuration error, not a crash) when the
 * provider, model or key is missing — the chat action turns that into the same
 * "assistant unavailable" message as the kill switch.
 */
export function resolveProvider(config: ProviderConfig, deps: { fetchImpl?: FetchLike } = {}): ChatProvider {
  const provider = (config.provider || "").trim().toLowerCase();
  const model = (config.model || "").trim();
  if (!(PROVIDER_IDS as readonly string[]).includes(provider)) {
    throw errors.configuration("errors.aiProviderUnsupported", `unknown provider: ${config.provider}`);
  }
  if (!model) throw errors.configuration("errors.aiNotConfigured", "no model selected");

  const key = config.secretRef ? process.env[config.secretRef] : undefined;
  if (!key) {
    throw errors.configuration(
      "errors.aiNotConfigured",
      `environment variable ${config.secretRef ?? "(none)"} is not set — the assistant has no key`,
    );
  }

  if (provider === "openai") {
    return createOpenAiProvider({ model, baseUrl: config.baseUrl, apiKey: key, fetchImpl: deps.fetchImpl });
  }
  return createAnthropicProvider({ model, baseUrl: config.baseUrl, apiKey: key, fetchImpl: deps.fetchImpl });
}

/** Provider failures are logged without request bodies (they may contain tenant data). */
export function describeProviderError(e: unknown): string {
  if (e instanceof ProviderError) return `${e.providerId}: ${e.message}`;
  if (e instanceof Error) return e.message;
  return String(e);
}

export function logProviderFailure(e: unknown, context: Record<string, unknown>): void {
  logger.warn({ err: e, ...context }, "assistant provider call failed");
}
