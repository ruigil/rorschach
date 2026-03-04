/**
 * CognitiveAgent — An agent with LLM-powered thinking capabilities.
 *
 * Composes a BaseAgent with a ModelProvider to give agents the ability to:
 *   - think()    — Single-turn reasoning / text generation
 *   - chat()     — Multi-turn conversation with memory
 *   - decide()   — Structured choice selection
 *   - summarize() — Text summarization
 *
 * All LLM calls emit cognitive events on the bus for full observability:
 *   - "cognitive:thinking" — before the call
 *   - "cognitive:complete" — after success
 *   - "cognitive:error"   — on failure
 */

import { BaseAgent } from "../agents/base-agent";
import type { EventBus } from "../events/event-bus";
import type { BaseEventMap } from "../events/types";
import type { InterfaceEvents } from "../interface";
import type {
  ChatMessage,
  CognitiveEvents,
  CompletionOptions,
  CompletionResult,
  ModelProvider,
} from "./types";

// ---------------------------------------------------------------------------
// CognitiveAgent Options
// ---------------------------------------------------------------------------

export type CognitiveAgentOptions<TEvents extends BaseEventMap = BaseEventMap> = {
  /** Unique agent identifier */
  id: string;

  /** Human-readable agent name */
  name: string;

  /** The event bus to communicate on */
  bus: EventBus<TEvents & CognitiveEvents>;

  /** The model provider for LLM calls */
  provider: ModelProvider;

  /** Optional system prompt that prefixes every conversation */
  systemPrompt?: string;

  /** Default completion options for this agent */
  defaultOptions?: Partial<CompletionOptions>;

  /** Maximum conversation history length (number of messages to retain) */
  maxHistoryLength?: number;
};

// ---------------------------------------------------------------------------
// CognitiveAgent Factory
// ---------------------------------------------------------------------------

/**
 * Create a cognitive agent that combines event-driven communication
 * with LLM-powered reasoning.
 *
 * @example
 * ```ts
 * const thinker = CognitiveAgent({
 *   id: "thinker-1",
 *   name: "Thinker",
 *   bus,
 *   provider: OpenRouterProvider({ apiKey: "..." }),
 *   systemPrompt: "You are a task decomposition expert.",
 * });
 *
 * await thinker.start();
 * const response = await thinker.think("How do I build a web server?");
 * ```
 */
export const CognitiveAgent = <TEvents extends BaseEventMap = BaseEventMap>(
  options: CognitiveAgentOptions<TEvents>,
) => {
  const {
    provider,
    defaultOptions,
    maxHistoryLength = 50,
  } = options;

  // Create the underlying base agent
  const agent = BaseAgent<TEvents & CognitiveEvents>({
    ...options,
  });

  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------

  /** System prompt prepended to every conversation */
  let systemPrompt: string | undefined = options.systemPrompt;

  /** Conversation history for multi-turn chat (default session) */
  let history: ChatMessage[] = [];

  /** Session-based conversation histories (keyed by sessionId) */
  const sessions = new Map<string, ChatMessage[]>();

  // -------------------------------------------------------------------------
  // System Prompt Management
  // -------------------------------------------------------------------------

  const setSystemPrompt = (prompt: string): void => {
    systemPrompt = prompt;
  };

  const getSystemPrompt = (): string | undefined => {
    return systemPrompt;
  };

  // -------------------------------------------------------------------------
  // Conversation History
  // -------------------------------------------------------------------------

  const clearHistory = (): void => {
    history = [];
  };

  const getHistory = (): readonly ChatMessage[] => {
    return [...history];
  };

  /**
   * Append a message to history, trimming if it exceeds maxHistoryLength.
   */
  const pushHistory = (message: ChatMessage): void => {
    history.push(message);
    // Trim from the front (oldest messages) but keep system prompt separate
    while (history.length > maxHistoryLength) {
      history.shift();
    }
  };

  // -------------------------------------------------------------------------
  // Internal: Build messages array with system prompt
  // -------------------------------------------------------------------------

  const buildMessages = (messages: ChatMessage[]): ChatMessage[] => {
    const result: ChatMessage[] = [];
    if (systemPrompt) {
      result.push({ role: "system", content: systemPrompt });
    }
    result.push(...messages);
    return result;
  };

  // -------------------------------------------------------------------------
  // Internal: Emit cognitive events + call provider
  // -------------------------------------------------------------------------

  // Internal helper to emit cognitive events without generic type friction.
  // The bus is typed as EventBus<TEvents & CognitiveEvents> so cognitive keys
  // are always present, but TS can't prove TEvents["cognitive:*"] matches
  // the concrete payload shape when TEvents is still generic. Casting through
  // `any` here is safe because CognitiveEvents is always part of the union.
  const emitCognitive = agent.emit as (
    type: string,
    payload: unknown,
    options?: Record<string, unknown>,
  ) => Promise<unknown>;

  const callProvider = async (
    messages: ChatMessage[],
    callOptions?: Partial<CompletionOptions>,
  ): Promise<CompletionResult> => {
    const model = callOptions?.model ?? defaultOptions?.model ?? "default";

    // Emit thinking event
    const promptPreview = messages
      .filter((m) => m.role === "user")
      .map((m) => m.content)
      .join(" ")
      .slice(0, 200);

    await emitCognitive("cognitive:thinking", {
      agentId: options.id,
      prompt: promptPreview,
      model,
    });

    const startTime = Date.now();

    try {
      const mergedOptions = { ...defaultOptions, ...callOptions };
      const result = await provider.complete(messages, mergedOptions);
      const durationMs = Date.now() - startTime;

      // Emit completion event
      await emitCognitive("cognitive:complete", {
        agentId: options.id,
        result: result.content.slice(0, 500),
        usage: result.usage,
        durationMs,
        model: result.model,
      });

      return result;
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);

      // Emit error event
      await emitCognitive("cognitive:error", {
        agentId: options.id,
        error: errorMessage,
        model,
      });

      throw err;
    }
  };

  // -------------------------------------------------------------------------
  // think() — Single-turn reasoning
  // -------------------------------------------------------------------------

  /**
   * Perform a single-turn reasoning call.
   * Does NOT modify conversation history.
   *
   * @param prompt    The user prompt
   * @param callOptions  Optional per-call overrides
   * @returns         The generated text content
   */
  const think = async (
    prompt: string,
    callOptions?: Partial<CompletionOptions>,
  ): Promise<string> => {
    const messages = buildMessages([{ role: "user", content: prompt }]);
    const result = await callProvider(messages, callOptions);
    return result.content;
  };

  // -------------------------------------------------------------------------
  // chat() — Multi-turn conversation with memory
  // -------------------------------------------------------------------------

  /**
   * Send a message in an ongoing conversation.
   * Appends to and uses conversation history.
   *
   * @param message     The user message
   * @param callOptions  Optional per-call overrides
   * @returns           The assistant's response text
   */
  const chat = async (
    message: string,
    callOptions?: Partial<CompletionOptions>,
  ): Promise<string> => {
    // Add user message to history
    pushHistory({ role: "user", content: message });

    // Build full message array with system prompt + history
    const messages = buildMessages(history);
    const result = await callProvider(messages, callOptions);

    // Add assistant response to history
    pushHistory({ role: "assistant", content: result.content });

    return result.content;
  };

  // -------------------------------------------------------------------------
  // chatRaw() — Multi-turn with full result metadata
  // -------------------------------------------------------------------------

  /**
   * Like chat(), but returns the full CompletionResult with usage stats.
   */
  const chatRaw = async (
    message: string,
    callOptions?: Partial<CompletionOptions>,
  ): Promise<CompletionResult> => {
    pushHistory({ role: "user", content: message });

    const messages = buildMessages(history);
    const result = await callProvider(messages, callOptions);

    pushHistory({ role: "assistant", content: result.content });

    return result;
  };

  // -------------------------------------------------------------------------
  // decide() — Structured decision making
  // -------------------------------------------------------------------------

  /**
   * Ask the model to choose from a set of options.
   *
   * Returns the index (0-based) of the chosen option, or -1 if the model's
   * response couldn't be parsed.
   *
   * @param question  The decision question
   * @param choices   Array of choice descriptions
   * @param callOptions  Optional per-call overrides
   * @returns         The chosen index and explanation
   */
  const decide = async (
    question: string,
    choices: string[],
    callOptions?: Partial<CompletionOptions>,
  ): Promise<{ choiceIndex: number; explanation: string }> => {
    const choiceList = choices
      .map((c, i) => `${i + 1}. ${c}`)
      .join("\n");

    const prompt = [
      `You must choose exactly one option for the following question.`,
      ``,
      `Question: ${question}`,
      ``,
      `Options:`,
      choiceList,
      ``,
      `Respond with ONLY a JSON object in this exact format (no markdown, no extra text):`,
      `{"choice": <number>, "explanation": "<brief reason>"}`,
      ``,
      `Where <number> is the option number (1-${choices.length}).`,
    ].join("\n");

    const messages = buildMessages([{ role: "user", content: prompt }]);
    const result = await callProvider(messages, {
      ...callOptions,
      temperature: 0.1, // Low temp for structured output
    });

    // Parse the JSON response
    try {
      const cleaned = result.content.trim().replace(/^```json?\s*/, "").replace(/\s*```$/, "");
      const parsed = JSON.parse(cleaned) as { choice: number; explanation: string };
      const choiceIndex = (parsed.choice ?? 0) - 1; // Convert 1-based → 0-based

      return {
        choiceIndex: choiceIndex >= 0 && choiceIndex < choices.length ? choiceIndex : -1,
        explanation: parsed.explanation ?? result.content,
      };
    } catch {
      return {
        choiceIndex: -1,
        explanation: result.content,
      };
    }
  };

  // -------------------------------------------------------------------------
  // summarize() — Text summarization
  // -------------------------------------------------------------------------

  /**
   * Summarize a piece of text.
   *
   * @param text         The text to summarize
   * @param instruction  Optional additional instruction (e.g. "in 3 bullet points")
   * @param callOptions  Optional per-call overrides
   * @returns            The summary text
   */
  const summarize = async (
    text: string,
    instruction?: string,
    callOptions?: Partial<CompletionOptions>,
  ): Promise<string> => {
    const prompt = [
      `Summarize the following text${instruction ? ` (${instruction})` : ""}:`,
      ``,
      text,
    ].join("\n");

    return think(prompt, callOptions);
  };

  // -------------------------------------------------------------------------
  // Session-based chat — Multi-turn with session isolation
  // -------------------------------------------------------------------------

  /**
   * Get or create a session history by sessionId.
   */
  const getOrCreateSession = (sessionId: string): ChatMessage[] => {
    let session = sessions.get(sessionId);
    if (!session) {
      session = [];
      sessions.set(sessionId, session);
    }
    return session;
  };

  /**
   * Append a message to a session's history, trimming if it exceeds maxHistoryLength.
   */
  const pushSessionHistory = (sessionId: string, message: ChatMessage): void => {
    const session = getOrCreateSession(sessionId);
    session.push(message);
    while (session.length > maxHistoryLength) {
      session.shift();
    }
  };

  /**
   * Send a message in a session-scoped conversation.
   * Each session maintains its own isolated history.
   *
   * @param sessionId   Unique session identifier (e.g. user ID, channel ID)
   * @param message     The user message
   * @param callOptions Optional per-call overrides
   * @returns           The assistant's response text
   */
  const chatSession = async (
    sessionId: string,
    message: string,
    callOptions?: Partial<CompletionOptions>,
  ): Promise<string> => {
    pushSessionHistory(sessionId, { role: "user", content: message });

    const session = getOrCreateSession(sessionId);
    const messages = buildMessages(session);
    const result = await callProvider(messages, callOptions);

    pushSessionHistory(sessionId, { role: "assistant", content: result.content });

    return result.content;
  };

  /**
   * Like chatSession(), but returns the full CompletionResult with usage stats.
   */
  const chatSessionRaw = async (
    sessionId: string,
    message: string,
    callOptions?: Partial<CompletionOptions>,
  ): Promise<CompletionResult> => {
    pushSessionHistory(sessionId, { role: "user", content: message });

    const session = getOrCreateSession(sessionId);
    const messages = buildMessages(session);
    const result = await callProvider(messages, callOptions);

    pushSessionHistory(sessionId, { role: "assistant", content: result.content });

    return result;
  };

  /**
   * Get the conversation history for a specific session.
   */
  const getSessionHistory = (sessionId: string): readonly ChatMessage[] => {
    return [...(sessions.get(sessionId) ?? [])];
  };

  /**
   * Clear a specific session's history.
   */
  const clearSession = (sessionId: string): void => {
    sessions.delete(sessionId);
  };

  /**
   * List all active session IDs.
   */
  const listSessions = (): string[] => {
    return [...sessions.keys()];
  };

  // -------------------------------------------------------------------------
  // generate() — Structured generation with custom instructions
  // -------------------------------------------------------------------------

  /**
   * Generate content with full control over the message array.
   * Does NOT modify conversation history.
   *
   * @param messages    Full message array (system prompt is still prepended)
   * @param callOptions  Optional per-call overrides
   * @returns           Full CompletionResult
   */
  const generate = async (
    messages: ChatMessage[],
    callOptions?: Partial<CompletionOptions>,
  ): Promise<CompletionResult> => {
    const fullMessages = buildMessages(messages);
    return callProvider(fullMessages, callOptions);
  };

  // -------------------------------------------------------------------------
  // Return the cognitive agent
  // -------------------------------------------------------------------------

  return {
    // --- BaseAgent (spread) ---
    ...agent,

    // --- Cognitive capabilities ---
    think,
    chat,
    chatRaw,
    decide,
    summarize,
    generate,

    // --- System prompt ---
    setSystemPrompt,
    getSystemPrompt,

    // --- History (default session) ---
    clearHistory,
    getHistory,

    // --- Session-based chat ---
    chatSession,
    chatSessionRaw,
    getSessionHistory,
    clearSession,
    listSessions,

    // --- Provider info ---
    provider: () => provider,
    agentId: () =>  options,
    agentName: () => options.name,
  };
};
