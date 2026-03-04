/**
 * InterfaceAgent — A stateless gateway that bridges external inputs
 * to the internal agent system via the EventBus.
 *
 * The interface agent:
 *   - Manages one or more adapters (HTTP, WebSocket, etc.)
 *   - Receives external messages → emits request on bus → awaits reply
 *   - Routes outbound push messages from bus → duplex adapters → external clients
 *   - Emits observability events for all interface activity
 *
 * It does NOT hold session state — that lives in the CognitiveAgent.
 * It does NOT have LLM capabilities — it delegates via bus events.
 *
 * Flow:
 *   External → Adapter → InterfaceAgent → bus.request("interface:chat") →
 *   CognitiveAgent handles & replies → InterfaceAgent → Adapter → External
 */

import { BaseAgent } from "../agents/base-agent";
import type { EventBus } from "../events/event-bus";
import type { BaseEventMap } from "../events/types";
import type {
  MessageHandler,
  InterfaceAdapter,
  InterfaceEvents,
  InterfaceMessage,
  InterfaceResponse,
} from "./types";

// ---------------------------------------------------------------------------
// InterfaceAgent Options
// ---------------------------------------------------------------------------

export type InterfaceAgentOptions<TEvents extends BaseEventMap = BaseEventMap> = {
  /** Unique agent identifier */
  id: string;

  /** Human-readable agent name */
  name: string;

  /** The event bus to communicate on */
  bus: EventBus<TEvents & InterfaceEvents>;

  /** Adapters to manage (HTTP, WebSocket, etc.) */
  adapters: InterfaceAdapter[];

  /** Timeout for waiting on bus reply (default: 30000ms) */
  replyTimeoutMs?: number;
};

// ---------------------------------------------------------------------------
// InterfaceAgent Factory
// ---------------------------------------------------------------------------

/**
 * Create a interface agent that bridges external inputs to the internal system.
 *
 * @example
 * ```ts
 * const gateway = InterfaceAgent({
 *   id: "gateway-1",
 *   name: "API Gateway",
 *   bus,
 *   adapters: [httpAdapter, wsAdapter],
 * });
 *
 * await gateway.start();
 * // HTTP and WebSocket servers are now listening
 * // Messages flow: external → adapter → bus → cognitive → bus → adapter → external
 * ```
 */
export const InterfaceAgent = <TEvents extends BaseEventMap = BaseEventMap>(
  options: InterfaceAgentOptions<TEvents>,
) => {
  const {
    adapters,
    replyTimeoutMs = 30_000,
  } = options;

  // Create the underlying base agent
  const agent = BaseAgent<TEvents & InterfaceEvents>({
    id: options.id,
    name: options.name,
    bus: options.bus,
  });

  // Internal helpers to emit/request interface events without generic type friction.
  // Same pattern used by CognitiveAgent — safe because InterfaceEvents is
  // always part of the union.
  const emitInterface = agent.emit as (
    type: string,
    payload: unknown,
    options?: Record<string, unknown>,
  ) => Promise<unknown>;

  const requestInterface = agent.request as (
    type: string,
    payload: unknown,
    options?: Record<string, unknown>,
  ) => Promise<{ payload: Record<string, unknown> }>;

  // -------------------------------------------------------------------------
  // Message Handler — called by adapters on inbound messages
  // -------------------------------------------------------------------------

  /**
   * Handle an inbound message from any adapter.
   * Emits a request on the bus and waits for a reply from a cognitive agent.
   */
  const handleMessage: MessageHandler = async (
    message: InterfaceMessage,
  ): Promise<InterfaceResponse> => {
    const startTime = Date.now();

    // Emit observability event
    await emitInterface("interface:message:received", {
      content: message.content.slice(0, 200),
      sessionId: message.sessionId,
      source: message.source,
      adapter: message.source,
    });

    try {
      // Use request/reply to delegate to a cognitive agent (or any handler)
      const reply = await requestInterface(
        "interface:chat",
        {
          content: message.content,
          sessionId: message.sessionId,
          source: message.source,
        },
        { timeoutMs: replyTimeoutMs },
      );

      const durationMs = Date.now() - startTime;

      const response: InterfaceResponse = {
        content: reply.payload.content as string,
        sessionId: message.sessionId,
      };

      // Emit observability event
      await emitInterface("interface:response:sent", {
        content: response.content.slice(0, 200),
        sessionId: message.sessionId,
        adapter: message.source,
        durationMs,
      });

      return response;
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);

      // Emit error event
      await emitInterface("interface:error", {
        error: errorMessage,
        sessionId: message.sessionId,
        adapter: message.source,
      });

      return {
        content: "Sorry, I'm unable to process your message right now. Please try again later.",
        sessionId: message.sessionId,
        type: "error",
      };
    }
  };

  // -------------------------------------------------------------------------
  // Push routing — bus → duplex adapters → external clients
  // -------------------------------------------------------------------------

  /**
   * Route a push message from the bus to all duplex adapters.
   */
  const setupPushRouting = (): void => {
    agent.on("interface:push", async (event) => {
      const { content, sessionId, type } = event.payload;

      const response: InterfaceResponse = { content, sessionId, type };

      for (const adapter of adapters) {
        if (adapter.duplex && adapter.send) {
          try {
            const delivered = await adapter.send(sessionId, response);
            if (delivered) {
              await emitInterface("interface:push:sent", {
                content: content.slice(0, 200),
                sessionId,
                adapter: adapter.name,
                type,
              });
            }
          } catch (err) {
            const errorMessage = err instanceof Error ? err.message : String(err);
            await emitInterface("interface:error", {
              error: `Push failed on ${adapter.name}: ${errorMessage}`,
              sessionId,
              adapter: adapter.name,
            });
          }
        }
      }
    });
  };

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  const start = async (): Promise<void> => {
    await agent.start();

    // Setup push routing for duplex adapters
    setupPushRouting();

    // Start all adapters with the message handler
    for (const adapter of adapters) {
      await adapter.start(handleMessage);

      await emitInterface("interface:adapter:started", {
        adapter: adapter.name,
        duplex: adapter.duplex,
      });
    }
  };

  const stop = async (): Promise<void> => {
    // Stop all adapters
    for (const adapter of adapters) {
      await adapter.stop();

      await emitInterface("interface:adapter:stopped", {
        adapter: adapter.name,
      });
    }

    await agent.stop();
  };

  // -------------------------------------------------------------------------
  // Return the interface agent
  // -------------------------------------------------------------------------

  return {
    ...agent,

    // Override lifecycle to manage adapters
    start,
    stop,

    // Expose adapters for inspection
    get adapters() { return [...adapters]; },
    get agentId() { return options.id; },
    get agentName() { return options.name; },
  };
};
