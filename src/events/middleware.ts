/**
 * Built-in middleware for the EventBus.
 *
 *   - loggingMiddleware    — logs every event with timing
 *   - deadLetterMiddleware — captures events with zero handlers
 *   - filterMiddleware     — conditionally drops events
 */

import type { EventEnvelope, Middleware } from "./types";

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

export type LoggingOptions = {
  /** Custom log function (defaults to console.log) */
  log?: (...args: unknown[]) => void;
  /** If true, also log the full payload (can be noisy) */
  verbose?: boolean;
}

/**
 * Logs every event as it enters and exits the pipeline, including duration.
 */
export const loggingMiddleware = (options: LoggingOptions = {}): Middleware => {
  const log = options.log ?? console.log;
  const verbose = options.verbose ?? false;

  return async (event, next) => {
    const tag = `[${event.source}] ${event.type}`;
    const trace = `trace=${event.traceId.slice(0, 8)}`;
    const parent = event.parentId ? ` parent=${event.parentId.slice(0, 8)}` : "";

    if (verbose) {
      log(`→ ${tag} (${trace}${parent})`, event.payload);
    } else {
      log(`→ ${tag} (${trace}${parent})`);
    }

    const start = performance.now();
    await next();
    const ms = (performance.now() - start).toFixed(2);

    log(`← ${tag} handled in ${ms}ms`);
  };
}

// ---------------------------------------------------------------------------
// Dead Letter
// ---------------------------------------------------------------------------

export type DeadLetterHandler = (event: EventEnvelope) => void | Promise<void>;

/**
 * Calls `onDeadLetter` for events that have no subscribers.
 *
 * NOTE: This middleware relies on a listener-count check. It should be
 * registered **after** all agents have started so counts are accurate.
 * It uses a supplied `listenerCount` function (bind to `bus.listenerCount`).
 */
export const deadLetterMiddleware = (
  listenerCount: (type: string) => number,
  onDeadLetter: DeadLetterHandler = (e) =>
    console.warn(`[DeadLetter] No handlers for "${e.type}"`, e),
): Middleware => {
  return async (event, next) => {
    // Internal reply channels are expected to sometimes have 0 listeners
    // (the subscription is set up just-in-time), so skip them.
    if (event.type.startsWith("__reply__:")) {
      await next();
      return;
    }

    if (listenerCount(event.type) === 0) {
      await onDeadLetter(event);
      return; // don't call next — there's nobody to handle it
    }

    await next();
  };
}

// ---------------------------------------------------------------------------
// Filter
// ---------------------------------------------------------------------------

export type EventPredicate = (event: EventEnvelope) => boolean;

/**
 * Drops events that don't match the predicate (never calls `next()`).
 */
export const filterMiddleware = (predicate: EventPredicate): Middleware => {
  return async (event, next) => {
    if (predicate(event)) {
      await next();
    }
    // else: silently dropped
  };
}
