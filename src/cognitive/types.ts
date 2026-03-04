/**
 * Core type definitions for the cognitive capabilities module.
 *
 * Provides a provider-agnostic interface for interacting with LLM model
 * providers (OpenRouter, Anthropic, Ollama, etc.)
 */

// ---------------------------------------------------------------------------
// Chat Messages
// ---------------------------------------------------------------------------

export type ChatRole = "system" | "user" | "assistant";

export type ChatMessage = {
  readonly role: ChatRole;
  readonly content: string;
};

// ---------------------------------------------------------------------------
// Completion Options
// ---------------------------------------------------------------------------

export type CompletionOptions = {
  /** Model identifier (e.g. "openai/gpt-4o-mini", "anthropic/claude-3.5-sonnet") */
  model: string;

  /** Sampling temperature (0..2). Lower = more deterministic. */
  temperature: number;

  /** Maximum tokens to generate */
  maxTokens: number;

  /** Nucleus sampling — top-p probability mass */
  topP: number;

  /** Stop sequences — generation halts when any of these are produced */
  stop: string[];

  /** Frequency penalty (-2..2) */
  frequencyPenalty: number;

  /** Presence penalty (-2..2) */
  presencePenalty: number;
};

// ---------------------------------------------------------------------------
// Completion Result
// ---------------------------------------------------------------------------

export type TokenUsage = {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
};

export type CompletionResult = {
  /** The generated text content */
  readonly content: string;

  /** The model that actually served the request */
  readonly model: string;

  /** Token usage statistics */
  readonly usage: TokenUsage;

  /** Why generation stopped: "stop", "length", "content_filter", etc. */
  readonly finishReason: string;

  /** The raw API response for advanced use cases */
  readonly raw: unknown;
};

// ---------------------------------------------------------------------------
// Provider Configuration
// ---------------------------------------------------------------------------

export type ModelProviderConfig = {
  /** API key for authentication */
  apiKey: string;

  /** Base URL override (useful for proxies or self-hosted endpoints) */
  baseUrl?: string;

  /** Default model to use if not specified per-request */
  defaultModel?: string;

  /** Default completion options applied to every request (overridable per-call) */
  defaultOptions?: Partial<CompletionOptions>;

  /** Application name sent in provider headers */
  appName?: string;
};

// ---------------------------------------------------------------------------
// Model Provider Interface
// ---------------------------------------------------------------------------

export type ModelProvider = {
  /** Human-readable provider name (e.g. "openrouter", "anthropic") */
  readonly name: string;

  /**
   * Send a chat completion request to the model.
   *
   * @param messages  Chat history (system + user + assistant turns)
   * @param options   Per-request overrides for model / sampling parameters
   * @returns         The model's response with metadata
   */
  complete(
    messages: ChatMessage[],
    options?: Partial<CompletionOptions>,
  ): Promise<CompletionResult>;

  /**
   * Convenience: single-turn text completion.
   *
   * Wraps the prompt in a single user message and returns just the content string.
   *
   * @param prompt   The user prompt
   * @param options  Per-request overrides
   * @returns        The generated text
   */
  completeText(
    prompt: string,
    options?: Partial<CompletionOptions>,
  ): Promise<string>;
};

// ---------------------------------------------------------------------------
// Cognitive Events (emitted on the bus for observability)
// ---------------------------------------------------------------------------

export type CognitiveEvents = {
  /** Fired when a cognitive agent begins an LLM call */
  "cognitive:thinking": {
    agentId: string;
    prompt: string;
    model: string;
  };

  /** Fired when an LLM call completes successfully */
  "cognitive:complete": {
    agentId: string;
    result: string;
    usage: TokenUsage;
    durationMs: number;
    model: string;
  };

  /** Fired when an LLM call fails */
  "cognitive:error": {
    agentId: string;
    error: string;
    model: string;
  };
};

// ---------------------------------------------------------------------------
// Provider Error
// ---------------------------------------------------------------------------

export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly provider: string,
    public readonly statusCode?: number,
    public readonly responseBody?: unknown,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}
