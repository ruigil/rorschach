/**
 * Core type definitions for the async event bus system.
 *
 * Event Envelope identity model:
 *   - id          — unique per event
 *   - traceId     — groups all events in a causal chain
 *   - parentId    — the event that caused this one (forms a causal tree)
 *   - correlationId — ties a request↔reply pair
 */

// ---------------------------------------------------------------------------
// Event Envelope
// ---------------------------------------------------------------------------

export type EventEnvelope<T = unknown> = {
  /** Unique identifier for this specific event */
  readonly id: string;

  /** Event type key, e.g. "task:assigned" */
  readonly type: string;

  /** The actual event data */
  readonly payload: T;

  /** Unix-ms timestamp of when the event was created */
  readonly timestamp: number;

  /** Id (or name) of the agent / component that emitted this event */
  readonly source: string;

  // -- Tracing ---------------------------------------------------------------

  /** Groups every event that belongs to the same causal chain */
  readonly traceId: string;

  /** The `id` of the event that directly caused this one (optional) */
  readonly parentId?: string;

  // -- Request / Reply -------------------------------------------------------

  /** Set automatically by the request() helper to match a reply to its request */
  readonly correlationId?: string;

  /** The event type that the requester is listening on for a reply */
  readonly replyTo?: string;
}

// ---------------------------------------------------------------------------
// Event Map — consumers extend this to get type-safe pub/sub
// ---------------------------------------------------------------------------

/**
 * An event map is a plain object type where keys are event type strings
 * and values are the payload types.
 *
 * Example:
 * ```ts
 * interface MyEvents {
 *   "task:submitted": { description: string };
 *   "task:completed": { taskId: string; result: unknown };
 * }
 * ```
 */
export type BaseEventMap = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export type EventHandler<T = unknown> = (
  event: EventEnvelope<T>,
) => Promise<void> | void;

// ---------------------------------------------------------------------------
// Subscription options
// ---------------------------------------------------------------------------

export type SubscriptionOptions = {
  /** Higher priority handlers execute first (default 0) */
  priority?: number;
}

// ---------------------------------------------------------------------------
// Subscription descriptor (returned wrapping unsubscribe)
// ---------------------------------------------------------------------------

export type Subscription = {
  /** Remove this subscription */
  unsubscribe: () => void;
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

export type Middleware = (
  event: EventEnvelope,
  next: () => Promise<void>,
) => Promise<void>;

// ---------------------------------------------------------------------------
// Emit options — extra metadata the emitter can attach
// ---------------------------------------------------------------------------

export type EmitOptions = {
  source?: string;
  traceId?: string;
  parentId?: string;
  correlationId?: string;
  replyTo?: string;
}
