/**
 * WebChatAgent — Example wiring that connects a InterfaceAgent (HTTP + WebSocket)
 * to a CognitiveAgent for LLM-powered chat over the web.
 *
 * This is NOT a new agent type — it's a convenience factory that creates and
 * wires together:
 *   1. A CognitiveAgent that listens for "interface:chat" and replies using session-based chat
 *   2. A InterfaceAgent with HTTP and WebSocket adapters
 *   3. Both communicate through the EventBus
 *
 * Usage:
 *   const { interfaceAgent, cognitiveAgent } = WebChatAgent({ bus, provider, ... });
 *   await interfaceAgent.start();
 *   await cognitiveAgent.start();
 *
 * Flow:
 *   HTTP POST /chat  ──► InterfaceAgent ──► bus "interface:chat" ──► CognitiveAgent
 *   WebSocket /ws     ──►                                               (chatSession)
 *                     ◄──                  ◄──   bus reply            ◄──
 */

import { CognitiveAgent } from "../../cognitive/cognitive-agent";
import type { CognitiveEvents, ModelProvider } from "../../cognitive/types";
import { EventBus } from "../../events/event-bus";
import type { InterfaceEvents } from "../types";

// ---------------------------------------------------------------------------
// Combined event map
// ---------------------------------------------------------------------------

export type WebChatEvents = InterfaceEvents & CognitiveEvents;

// ---------------------------------------------------------------------------
// WebChatAgent Options
// ---------------------------------------------------------------------------

export type WebChatAgentOptions = {
  /** The event bus (must include InterfaceEvents & CognitiveEvents) */
  bus: EventBus<WebChatEvents>;

  /** The LLM model provider */
  provider: ModelProvider;

  /** System prompt for the cognitive agent */
  systemPrompt?: string;

  /** HTTP port (default: 3000) */
  httpPort?: number;

  /** WebSocket port (default: 3001) */
  wsPort?: number;

  /** Directory to serve static files from (e.g. public/) */
  staticDir?: string;
};

// ---------------------------------------------------------------------------
// WebChatAgent Factory
// ---------------------------------------------------------------------------

/**
 * Create a full web chat stack: InterfaceAgent + CognitiveAgent wired together.
 *
 * @example
 * ```ts
 * const { interfaceAgent, cognitiveAgent } = WebChatAgent({
 *   bus,
 *   provider: OpenRouterProvider({ apiKey: "..." }),
 *   systemPrompt: "You are a helpful assistant.",
 *   httpPort: 3000,
 *   wsPort: 3001,
 *   staticDir: "./public",
 * });
 *
 * await cognitiveAgent.start();
 * await interfaceAgent.start();
 * // Now browse to http://localhost:3001 for WebSocket chat UI
 * // Or POST to http://localhost:3000/chat for REST API
 * ```
 */
export const WebChatAgent = (options: WebChatAgentOptions) => {
  const {
    bus,
    provider,
    systemPrompt = "You are a helpful, concise assistant.",
    httpPort = 3000,
    wsPort = 3000,
    staticDir,
  } = options;

  // -------------------------------------------------------------------------
  // 1. Create the CognitiveAgent
  // -------------------------------------------------------------------------

  const cognitiveAgent = CognitiveAgent<InterfaceEvents>({
    id: "cognitive-1",
    name: "Cognitive",
    bus,
    provider,
    systemPrompt,
    defaultOptions: {
      temperature: 0.7,
      maxTokens: 2048,
    },
  });

  cognitiveAgent.on("interface:chat", async (event) => {
    const { content, sessionId } = event.payload;

    try {
      // Use session-based chat so history is preserved per session
      const response = await cognitiveAgent.chatSession(sessionId, content);

      // Reply back through the bus (completes the request/reply cycle)
      await cognitiveAgent.reply(event, {
        content: response,
        sessionId,
      });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      await cognitiveAgent.reply(event, {
        content: `Error: ${errorMessage}`,
        sessionId,
      });
    }
  });


  return {
    ...cognitiveAgent,
    start: async (): Promise<void> => {
      await cognitiveAgent.start();
    },
    stop: async (): Promise<void> => {
      await cognitiveAgent.stop();
    },
  };
};
