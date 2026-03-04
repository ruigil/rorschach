/**
 * Core async EventBus implementation.
 *
 * Features:
 *   - Typed pub/sub via generic EventMap
 *   - Wildcard ("*") subscriptions
 *   - Handler priority ordering
 *   - Koa-style middleware pipeline
 *   - Request / Reply pattern via correlationId
 *   - Automatic traceId / parentId propagation
 */

import type {
  BaseEventMap,
  EmitOptions,
  EventEnvelope,
  EventHandler,
  Middleware,
  Subscription,
  SubscriptionOptions,
} from "./types";

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface HandlerEntry {
  handler: EventHandler<any>;
  priority: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function uid(): string {
  return crypto.randomUUID();
}

function buildEnvelope<T>(
  type: string,
  payload: T,
  options: EmitOptions = {},
): EventEnvelope<T> {
  return {
    id: uid(),
    type,
    payload,
    timestamp: Date.now(),
    source: options.source ?? "unknown",
    traceId: options.traceId ?? uid(),
    parentId: options.parentId,
    correlationId: options.correlationId,
    replyTo: options.replyTo,
  };
}

// ---------------------------------------------------------------------------
// EventBus
// ---------------------------------------------------------------------------

export class EventBus<TEvents extends BaseEventMap = BaseEventMap> {
  /** Map from event type → ordered list of handler entries */
  private handlers = new Map<string, HandlerEntry[]>();

  /** Wildcard handlers (receive every event) */
  private wildcardHandlers: HandlerEntry[] = [];

  /** Middleware stack (executed in registration order) */
  private middlewares: Middleware[] = [];

  // -------------------------------------------------------------------------
  // Middleware
  // -------------------------------------------------------------------------

  /**
   * Register middleware that wraps every event dispatch.
   * Middlewares execute in registration order (first registered = outermost).
   */
  use(middleware: Middleware): this {
    this.middlewares.push(middleware);
    return this;
  }

  // -------------------------------------------------------------------------
  // Subscribe
  // -------------------------------------------------------------------------

  /**
   * Subscribe to a specific event type.
   * Pass `"*"` to receive every event (wildcard).
   *
   * Returns a {@link Subscription} with an `unsubscribe()` method.
   */
  on<K extends keyof TEvents & string>(
    type: K | "*",
    handler: EventHandler<TEvents[K]>,
    options: SubscriptionOptions = {},
  ): Subscription {
    const entry: HandlerEntry = {
      handler,
      priority: options.priority ?? 0,
    };

    if (type === "*") {
      this.wildcardHandlers.push(entry);
      this.sortByPriority(this.wildcardHandlers);

      return {
        unsubscribe: () => {
          this.wildcardHandlers = this.wildcardHandlers.filter(
            (e) => e !== entry,
          );
        },
      };
    }

    const list = this.handlers.get(type) ?? [];
    list.push(entry);
    this.sortByPriority(list);
    this.handlers.set(type, list);

    return {
      unsubscribe: () => {
        const current = this.handlers.get(type);
        if (current) {
          this.handlers.set(
            type,
            current.filter((e) => e !== entry),
          );
        }
      },
    };
  }

  // -------------------------------------------------------------------------
  // Emit
  // -------------------------------------------------------------------------

  /**
   * Emit an event. All matching handlers (type-specific + wildcard) are
   * invoked concurrently via `Promise.allSettled`.
   *
   * Returns the fully-constructed {@link EventEnvelope} that was dispatched.
   */
  async emit<K extends keyof TEvents & string>(
    type: K,
    payload: TEvents[K],
    options: EmitOptions = {},
  ): Promise<EventEnvelope<TEvents[K]>> {
    const envelope = buildEnvelope(type, payload, options);
    await this.dispatch(envelope);
    return envelope;
  }

  // -------------------------------------------------------------------------
  // Request / Reply
  // -------------------------------------------------------------------------

  /**
   * Emit an event and wait for a single reply.
   *
   * Under the hood this:
   * 1. Generates a unique `correlationId` and a temporary reply event type.
   * 2. Subscribes to the reply type, filtered by `correlationId`.
   * 3. Emits the original event with `correlationId` and `replyTo` set.
   * 4. Resolves with the reply envelope (or rejects on timeout).
   *
   * @param timeoutMs  Max time to wait for a reply (default 30 000 ms).
   */
  request<K extends keyof TEvents & string, R = unknown>(
    type: K,
    payload: TEvents[K],
    options: EmitOptions & { timeoutMs?: number } = {},
  ): Promise<EventEnvelope<R>> {
    const correlationId = uid();
    const replyTo = `__reply__:${correlationId}`;
    const timeoutMs = options.timeoutMs ?? 30_000;

    return new Promise<EventEnvelope<R>>((resolve, reject) => {
      const timer = setTimeout(() => {
        sub.unsubscribe();
        reject(
          new Error(
            `Request "${type}" (correlationId=${correlationId}) timed out after ${timeoutMs}ms`,
          ),
        );
      }, timeoutMs);

      // Subscribe to the internal reply channel
      const sub = this.on(replyTo as any, ((event: EventEnvelope<R>) => {
        if (event.correlationId === correlationId) {
          clearTimeout(timer);
          sub.unsubscribe();
          resolve(event);
        }
      }) as any);

      // Emit the request event
      this.emit(type, payload, {
        ...options,
        correlationId,
        replyTo,
      }).catch((err) => {
        clearTimeout(timer);
        sub.unsubscribe();
        reject(err);
      });
    });
  }

  /**
   * Convenience: reply to a received request event.
   * Emits on the `replyTo` channel with the same `correlationId` and `traceId`.
   */
  async reply<T>(
    originalEvent: EventEnvelope,
    payload: T,
    source: string,
  ): Promise<void> {
    if (!originalEvent.replyTo || !originalEvent.correlationId) {
      throw new Error(
        "Cannot reply: original event has no replyTo / correlationId",
      );
    }

    await this.emit(originalEvent.replyTo as any, payload as any, {
      source,
      correlationId: originalEvent.correlationId,
      traceId: originalEvent.traceId,
      parentId: originalEvent.id,
    });
  }

  // -------------------------------------------------------------------------
  // Introspection
  // -------------------------------------------------------------------------

  /** Number of handlers registered for a specific event type (excluding wildcards). */
  listenerCount(type: string): number {
    return (this.handlers.get(type)?.length ?? 0) + this.wildcardHandlers.length;
  }

  /** All event types that have at least one handler registered. */
  eventTypes(): string[] {
    return [...this.handlers.keys()];
  }

  /** Remove all handlers and middleware. */
  clear(): void {
    this.handlers.clear();
    this.wildcardHandlers = [];
    this.middlewares = [];
  }

  // -------------------------------------------------------------------------
  // Internal dispatch
  // -------------------------------------------------------------------------

  private async dispatch(envelope: EventEnvelope): Promise<void> {
    // Build the composed middleware + handler chain
    const run = this.composeMiddleware(envelope, async () => {
      await this.invokeHandlers(envelope);
    });

    await run();
  }

  /**
   * Compose the middleware stack into a single callable function.
   * The innermost function (core) is the actual handler invocation.
   */
  private composeMiddleware(
    envelope: EventEnvelope,
    core: () => Promise<void>,
  ): () => Promise<void> {
    // Walk backwards so the first middleware registered is the outermost
    let next = core;
    for (let i = this.middlewares.length - 1; i >= 0; i--) {
      const mw = this.middlewares[i]!;
      const downstream = next;
      next = () => mw(envelope, downstream);
    }
    return next;
  }

  /**
   * Invoke all matching handlers (type-specific + wildcard) concurrently.
   * Uses `Promise.allSettled` so one failing handler doesn't break the rest.
   */
  private async invokeHandlers(envelope: EventEnvelope): Promise<void> {
    const typeHandlers = this.handlers.get(envelope.type) ?? [];
    const allHandlers = [...typeHandlers, ...this.wildcardHandlers];

    const results = await Promise.allSettled(
      allHandlers.map(async (entry) => entry.handler(envelope)),
    );

    // Surface handler errors as warnings (they don't break the bus)
    for (const result of results) {
      if (result.status === "rejected") {
        console.error(
          `[EventBus] Handler error for "${envelope.type}":`,
          result.reason,
        );
      }
    }
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private sortByPriority(entries: HandlerEntry[]): void {
    entries.sort((a, b) => b.priority - a.priority);
  }
}
