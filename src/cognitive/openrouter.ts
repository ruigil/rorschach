/**
 * OpenRouter Model Provider
 *
 * Implements the ModelProvider interface using OpenRouter's OpenAI-compatible
 * chat completions API. Zero runtime dependencies — uses Bun's native fetch().
 *
 * OpenRouter supports 200+ models from OpenAI, Anthropic, Google, Meta, Mistral,
 * and many more through a single unified API.
 *
 * @see https://openrouter.ai/docs
 */

import {
  ProviderError,
} from "./types";
import type {
  ChatMessage,
  CompletionOptions,
  CompletionResult,
  ModelProvider,
  ModelProviderConfig,
  TokenUsage,
} from "./types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_MODEL = "openai/gpt-4o-mini";

const DEFAULT_OPTIONS: CompletionOptions = {
  model: DEFAULT_MODEL,
  temperature: 0.7,
  maxTokens: 2048,
  topP: 1,
  stop: [],
  frequencyPenalty: 0,
  presencePenalty: 0,
};

// ---------------------------------------------------------------------------
// OpenRouter API response types
// ---------------------------------------------------------------------------

type OpenRouterChoice = {
  index: number;
  message: {
    role: string;
    content: string | null;
  };
  finish_reason: string | null;
};

type OpenRouterUsage = {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
};

type OpenRouterResponse = {
  id: string;
  model: string;
  choices: OpenRouterChoice[];
  usage?: OpenRouterUsage;
  error?: {
    message: string;
    type?: string;
    code?: number;
  };
};

// ---------------------------------------------------------------------------
// OpenRouterProvider Factory
// ---------------------------------------------------------------------------

/**
 * Create an OpenRouter model provider.
 *
 * @param config  Provider configuration (apiKey required, rest optional)
 * @returns       A ModelProvider instance backed by OpenRouter
 *
 * @example
 * ```ts
 * const provider = OpenRouterProvider({
 *   apiKey: process.env.OPENROUTER_API_KEY!,
 *   defaultModel: "anthropic/claude-3.5-sonnet",
 * });
 *
 * const result = await provider.complete([
 *   { role: "system", content: "You are a helpful assistant." },
 *   { role: "user", content: "Explain quantum computing in one sentence." },
 * ]);
 * ```
 */
export const OpenRouterProvider = (config: ModelProviderConfig): ModelProvider => {
  const baseUrl = config.baseUrl ?? OPENROUTER_BASE_URL;
  const defaultModel = config.defaultModel ?? DEFAULT_MODEL;
  const appName = config.appName ?? "Rorschach";

  // Merge user defaults with our defaults
  const defaultOpts: CompletionOptions = {
    ...DEFAULT_OPTIONS,
    model: defaultModel,
    ...config.defaultOptions,
  };

  // -------------------------------------------------------------------------
  // Internal: build request
  // -------------------------------------------------------------------------

  const buildRequestBody = (
    messages: ChatMessage[],
    options: CompletionOptions,
  ): Record<string, unknown> => {
    const body: Record<string, unknown> = {
      model: options.model,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      temperature: options.temperature,
      max_tokens: options.maxTokens,
      top_p: options.topP,
    };

    if (options.stop.length > 0) {
      body.stop = options.stop;
    }
    if (options.frequencyPenalty !== 0) {
      body.frequency_penalty = options.frequencyPenalty;
    }
    if (options.presencePenalty !== 0) {
      body.presence_penalty = options.presencePenalty;
    }

    return body;
  };

  const buildHeaders = (): Record<string, string> => ({
    "Content-Type": "application/json",
    Authorization: `Bearer ${config.apiKey}`,
    "HTTP-Referer": "https://github.com/rorschach-agents",
    "X-Title": appName,
  });

  // -------------------------------------------------------------------------
  // Internal: parse response
  // -------------------------------------------------------------------------

  const parseResponse = (raw: OpenRouterResponse): CompletionResult => {
    // Handle API-level errors
    if (raw.error) {
      throw new ProviderError(
        `OpenRouter API error: ${raw.error.message}`,
        "openrouter",
        raw.error.code,
        raw,
      );
    }

    const choice = raw.choices?.[0];
    if (!choice) {
      throw new ProviderError(
        "OpenRouter returned no choices",
        "openrouter",
        undefined,
        raw,
      );
    }

    const content = choice.message?.content ?? "";

    const usage: TokenUsage = {
      promptTokens: raw.usage?.prompt_tokens ?? 0,
      completionTokens: raw.usage?.completion_tokens ?? 0,
      totalTokens: raw.usage?.total_tokens ?? 0,
    };

    return {
      content,
      model: raw.model ?? defaultModel,
      usage,
      finishReason: choice.finish_reason ?? "unknown",
      raw,
    };
  };

  // -------------------------------------------------------------------------
  // complete()
  // -------------------------------------------------------------------------

  const complete = async (
    messages: ChatMessage[],
    options?: Partial<CompletionOptions>,
  ): Promise<CompletionResult> => {
    const mergedOptions: CompletionOptions = {
      ...defaultOpts,
      ...options,
    };

    const url = `${baseUrl}/chat/completions`;
    const body = buildRequestBody(messages, mergedOptions);
    const headers = buildHeaders();

    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new ProviderError(
        `OpenRouter network error: ${err instanceof Error ? err.message : String(err)}`,
        "openrouter",
      );
    }

    if (!response.ok) {
      let errorBody: unknown;
      try {
        errorBody = await response.json();
      } catch {
        errorBody = await response.text().catch(() => "unable to read body");
      }

      throw new ProviderError(
        `OpenRouter HTTP ${response.status}: ${
          typeof errorBody === "object" && errorBody !== null && "error" in errorBody
            ? (errorBody as { error: { message: string } }).error?.message ?? response.statusText
            : response.statusText
        }`,
        "openrouter",
        response.status,
        errorBody,
      );
    }

    const json = (await response.json()) as OpenRouterResponse;
    return parseResponse(json);
  };

  // -------------------------------------------------------------------------
  // completeText()
  // -------------------------------------------------------------------------

  const completeText = async (
    prompt: string,
    options?: Partial<CompletionOptions>,
  ): Promise<string> => {
    const result = await complete(
      [{ role: "user", content: prompt }],
      options,
    );
    return result.content;
  };

  // -------------------------------------------------------------------------
  // Return provider
  // -------------------------------------------------------------------------

  return {
    name: "openrouter",
    complete,
    completeText,
  };
};
