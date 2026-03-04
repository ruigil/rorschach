/**
 * RAG Agent — Retrieval-Augmented Generation using MemoryAgent + CognitiveAgent.
 *
 * Demonstrates how to combine semantic memory with LLM reasoning:
 *   1. Store knowledge as memories (vector-embedded)
 *   2. Before answering a question, recall relevant memories
 *   3. Inject retrieved context into the LLM prompt
 *   4. Optionally persist new learnings from conversations
 *
 * This is a complete example showing the integration pattern between
 * the memory module and the cognitive module.
 */

import { EventBus } from "../../events/event-bus";
import { CognitiveAgent } from "../../cognitive/cognitive-agent";
import { MemoryAgent } from "../memory-agent";
import { RuvectorStore, RuvectorEmbedder } from "../ruvector-store";
import type { BaseEventMap } from "../../events/types";
import type { CognitiveEvents, ModelProvider } from "../../cognitive/types";
import type { MemoryEvents } from "../types";

// ---------------------------------------------------------------------------
// Event types for the RAG system
// ---------------------------------------------------------------------------

type RagEvents = CognitiveEvents & MemoryEvents & {
  "rag:query": { query: string; context: string };
  "rag:response": { query: string; response: string; memoriesUsed: number };
};

// ---------------------------------------------------------------------------
// RAG Agent Options
// ---------------------------------------------------------------------------

export type RagAgentOptions = {
  /** Unique agent identifier */
  id?: string;

  /** Human-readable name */
  name?: string;

  /** LLM model provider */
  provider: ModelProvider;

  /** System prompt for the LLM */
  systemPrompt?: string;

  /** Embedding dimensions (default 128) */
  dimensions?: number;

  /** Number of memories to retrieve per query (default 3) */
  topK?: number;

  /** Minimum similarity threshold (default 0.1) */
  threshold?: number;
};

// ---------------------------------------------------------------------------
// RAG Agent Factory
// ---------------------------------------------------------------------------

/**
 * Create a RAG (Retrieval-Augmented Generation) agent.
 *
 * Combines a MemoryAgent for knowledge storage + retrieval with a
 * CognitiveAgent for LLM-powered reasoning. Retrieved memories are
 * automatically injected as context into every LLM call.
 *
 * @example
 * ```ts
 * const rag = RagAgent({
 *   provider: OpenRouterProvider({ apiKey: "..." }),
 *   systemPrompt: "You are a helpful assistant with access to a knowledge base.",
 * });
 *
 * await rag.start();
 *
 * // Teach the agent
 * await rag.learn("Rorschach uses an async event bus for agent communication.");
 * await rag.learn("The project is built with Bun and TypeScript.");
 *
 * // Ask questions — memories are auto-retrieved and injected
 * const answer = await rag.ask("What runtime does Rorschach use?");
 * console.log(answer);
 * // → "Rorschach is built with Bun..." (informed by retrieved memories)
 * ```
 */
export const RagAgent = (options: RagAgentOptions) => {
  const {
    id = "rag-agent",
    name = "RAG Agent",
    provider,
    systemPrompt = "You are a helpful assistant with access to a knowledge base. Use the provided context to answer questions accurately. If the context doesn't contain relevant information, say so.",
    dimensions = 128,
    topK = 3,
    threshold = 0.1,
  } = options;

  const bus = new EventBus<RagEvents>();

  // Create the memory agent for knowledge storage + retrieval
  const memory = MemoryAgent({
    id: `${id}-memory`,
    name: `${name} Memory`,
    bus,
    vectorStore: RuvectorStore({ dimensions }),
    embedder: RuvectorEmbedder({ dimensions }),
  });

  // Create the cognitive agent for LLM reasoning
  const cognitive = CognitiveAgent({
    id: `${id}-cognitive`,
    name: `${name} Cognitive`,
    bus,
    provider,
    systemPrompt,
  });

  // -------------------------------------------------------------------------
  // Core operations
  // -------------------------------------------------------------------------

  /**
   * Store a piece of knowledge in memory.
   */
  const learn = async (
    content: string,
    metadata?: Record<string, unknown>,
  ): Promise<string> => {
    return memory.store(content, metadata);
  };

  /**
   * Ask a question with automatic memory retrieval (RAG).
   *
   * 1. Retrieves relevant memories
   * 2. Builds an augmented prompt with context
   * 3. Sends to the LLM
   * 4. Returns the response
   */
  const ask = async (question: string): Promise<string> => {
    // Retrieve relevant context from memory
    const context = await memory.remember(question, topK, threshold);

    // Build augmented prompt
    let augmentedPrompt: string;
    if (context) {
      augmentedPrompt = `${context}\n\nQuestion: ${question}`;
    } else {
      augmentedPrompt = `[No relevant memories found]\n\nQuestion: ${question}`;
    }

    // Emit RAG query event
    await bus.emit("rag:query", {
      query: question,
      context: context || "(none)",
    });

    // Get LLM response with augmented context
    const response = await cognitive.think(augmentedPrompt);

    // Emit RAG response event
    await bus.emit("rag:response", {
      query: question,
      response: response.slice(0, 500),
      memoriesUsed: context ? context.split("\n").length - 1 : 0,
    });

    return response;
  };

  /**
   * Chat with memory-augmented responses (multi-turn).
   * Each message retrieves relevant memories and adds them to the conversation.
   */
  const chat = async (message: string): Promise<string> => {
    const context = await memory.remember(message, topK, threshold);

    let augmentedMessage: string;
    if (context) {
      augmentedMessage = `${context}\n\nUser: ${message}`;
    } else {
      augmentedMessage = message;
    }

    return cognitive.chat(augmentedMessage);
  };

  /**
   * Learn from a conversation: store all messages as recoverable memories.
   */
  const learnFromConversation = async (
    messages: Array<{ role: string; content: string }>,
  ): Promise<string[]> => {
    return memory.storeConversation(messages);
  };

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  const start = async (): Promise<void> => {
    await memory.start();
    await cognitive.start();
  };

  const stop = async (): Promise<void> => {
    await cognitive.stop();
    await memory.stop();
  };

  // -------------------------------------------------------------------------
  // Return the RAG agent
  // -------------------------------------------------------------------------

  return {
    // Lifecycle
    start,
    stop,

    // Core RAG operations
    ask,
    chat,
    learn,
    learnFromConversation,

    // Direct access to underlying agents
    memory: () => memory,
    cognitive: () => cognitive,
    bus: () => bus,
  };
};
