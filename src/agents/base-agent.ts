/**
 * Abstract base class for agents that communicate via the EventBus.
 *
 * Provides:
 *   - Lifecycle: start() / stop()
 *   - Convenience wrappers: emit(), on(), request(), reply()
 *   - Automatic traceId + parentId propagation
 *   - Automatic cleanup of subscriptions on stop()
 */

import type {
  BaseEventMap,
  EmitOptions,
  EventEnvelope,
  EventHandler,
  Subscription,
  SubscriptionOptions,
} from "../events/types";
import type { EventBus } from "../events/event-bus";

// ---------------------------------------------------------------------------
// BaseAgent Types
// ---------------------------------------------------------------------------

export type BaseAgentInstance<TEvents extends BaseEventMap = BaseEventMap> = {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  isRunning: () => boolean;
  on: <K extends keyof TEvents & string>(
    type: K | "*",
    handler: EventHandler<TEvents[K]>,
    subOptions?: SubscriptionOptions,
  ) => Subscription;
  emit: <K extends keyof TEvents & string>(
    type: K,
    payload: TEvents[K],
    eOptions?: Partial<EmitOptions>,
  ) => Promise<EventEnvelope<TEvents[K]>>;
  request: <K extends keyof TEvents & string, R = unknown>(
    type: K,
    payload: TEvents[K],
    eOptions?: Partial<EmitOptions> & { timeoutMs?: number },
  ) => Promise<EventEnvelope<R>>;
  reply: <T>(
    originalEvent: EventEnvelope,
    payload: T,
  ) => Promise<void>;
};

export type BaseAgentOptions<TEvents extends BaseEventMap = BaseEventMap> = {
  id: string;
  name: string;
  bus: EventBus<TEvents>;
  setup?: (base: BaseAgentInstance<TEvents>) => void;
};

// ---------------------------------------------------------------------------
// BaseAgent
// ---------------------------------------------------------------------------

export const BaseAgent = <TEvents extends BaseEventMap = BaseEventMap>
  (options: BaseAgentOptions<TEvents>): BaseAgentInstance<TEvents> => {

  /** Active subscriptions — cleaned up automatically on stop() */
  const subscriptions: Subscription[] = [];

  /**
   * The event currently being handled (if any).
   * Used to auto-propagate traceId / parentId when the agent emits
   * new events in response to a received event.
   */
  let currentContext: EventEnvelope | undefined;

  /** Whether the agent has been started */
  let running = false;

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Start the agent.
   * Calling start() multiple times is a no-op.
   */
  const start = async (): Promise<void> => {
    if (running) return;
    running = true;
    // Call setup function if provided
    if (options.setup) {
      options.setup({
        start,
        stop,
        isRunning,
        on,
        emit,
        request,
        reply,
      });
    }
  }

  /**
   * Stop the agent — unsubscribes all handlers.
   */
  const stop = async (): Promise<void> => {
    if (!running) return;
    running = false;
    for (const sub of subscriptions) {
      sub.unsubscribe();
    }
    subscriptions.length = 0;
  }

  /** Whether the agent is currently running */
  const isRunning = (): boolean => {
    return running;
  }

  // -------------------------------------------------------------------------
  // Convenience: subscribe
  // -------------------------------------------------------------------------

  /**
   * Subscribe to an event type on the bus.
   *
   * The handler will receive events wrapped with automatic context tracking,
   * so that any `emit()` calls made *within* the handler will automatically
   * inherit `traceId` / `parentId` from the triggering event.
   */
  const on = <K extends keyof TEvents & string> (
    type: K | "*",
    handler: EventHandler<TEvents[K]>,
    subOptions?: SubscriptionOptions,
  ): Subscription => {
    // Wrap the user's handler to set currentContext during execution
    const wrappedHandler: EventHandler<TEvents[K]> = async (event) => {
      const previousContext = currentContext;
      currentContext = event;
      try {
        await handler(event);
      } finally {
        currentContext = previousContext;
      }
    };

    const sub = options.bus.on(type, wrappedHandler, subOptions);
    subscriptions.push(sub);
    return sub;
  }

  // -------------------------------------------------------------------------
  // Convenience: emit
  // -------------------------------------------------------------------------

  /**
   * Emit an event on the bus.
   *
   * Automatically sets:
   *   - `source` to this agent's id
   *   - `traceId` from the current handling context (if any)
   *   - `parentId` from the current handling context's id (if any)
   */
  const emit = async <K extends keyof TEvents & string> (
    type: K,
    payload: TEvents[K],
    eOptions: Partial<EmitOptions> = {},
  ): Promise<EventEnvelope<TEvents[K]>> => {
    return options.bus.emit(type, payload, {
      source: options.id,
      traceId: currentContext?.traceId,
      parentId: currentContext?.id,
      ...eOptions,
    });
  }

  // -------------------------------------------------------------------------
  // Convenience: request / reply
  // -------------------------------------------------------------------------

  /**
   * Send a request event and wait for a reply.
   * Automatically propagates trace context.
   */
  const request = <K extends keyof TEvents & string, R = unknown>(
    type: K,
    payload: TEvents[K],
    eOptions: Partial<EmitOptions> & { timeoutMs?: number } = {},
  ): Promise<EventEnvelope<R>> => {
    return options.bus.request<K, R>(type, payload, {
      source: options.id,
      traceId: currentContext?.traceId,
      parentId: currentContext?.id,
      ...eOptions,
    });
  }

  /**
   * Reply to a request event.
   */
  const reply = <T>(
    originalEvent: EventEnvelope,
    payload: T,
  ): Promise<void> => {
    return options.bus.reply(originalEvent, payload, options.id);
  }

  return {
    start,
    stop,
    on,
    emit,
    request,
    reply,
    isRunning,
  }

}
