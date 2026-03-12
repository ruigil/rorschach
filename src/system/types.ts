// ─── Sentinel for mailbox close ───
export const STOP = Symbol('STOP')
export type Stop = typeof STOP

// ─── Timer Key ───
export type TimerKey = string | symbol

// ─── Timers (scoped to an actor's lifecycle) ───
export type Timers<M> = {
  /** Send `message` to self after `delayMs`. Fires once. Replaces any existing timer with the same key. */
  readonly startSingleTimer: (key: TimerKey, message: M, delayMs: number) => void
  /** Send `message` to self every `intervalMs`. Replaces any existing timer with the same key. */
  readonly startPeriodicTimer: (key: TimerKey, message: M, intervalMs: number) => void
  /** Cancel a specific timer by key. No-op if not set. */
  readonly cancel: (key: TimerKey) => void
  /** Cancel all active timers. */
  readonly cancelAll: () => void
  /** Check if a timer with this key is active. */
  readonly isActive: (key: TimerKey) => boolean
}

// ─── Mailbox ───
export type Mailbox<T> = {
  enqueue: (item: T) => void
  take: () => Promise<T | Stop>
  close: () => void
}

// ─── Actor Reference (opaque handle) ───
export type ActorRef<M> = {
  readonly name: string
  readonly send: (message: M) => void
}

// ─── Minimal reference (used where we only need identity, not send) ───
export type ActorIdentity = { readonly name: string }

// ─── Supervision Strategy ───
export type SupervisionStrategy =
  | { type: 'stop' }
  | { type: 'restart'; maxRetries?: number; withinMs?: number }
  | { type: 'escalate' }

// ─── Lifecycle Events ───
export type LifecycleEvent =
  | { type: 'started' }
  | { type: 'stopped' }
  | { type: 'child-started'; child: ActorIdentity }
  | { type: 'child-stopped'; child: ActorIdentity }
  | { type: 'child-failed'; child: ActorIdentity; error: unknown }

// ─── Actor Result (returned from handlers) ───
export type ActorResult<S> = { state: S }

// ─── Actor Context (available to handlers) ───
export type ActorContext<M> = {
  readonly self: ActorRef<M>
  readonly timers: Timers<M>
  readonly spawn: <CM, CS>(
    name: string,
    def: ActorDef<CM, CS>,
    initialState: CS,
  ) => ActorRef<CM>
  readonly stop: (child: ActorIdentity) => void
}

// ─── Actor Definition (behavior specification) ───
export type ActorDef<M, S> = {
  /** Runs once on start (or restart). Receives initial state + context. Returns the enriched initial state. */
  setup?: (state: S, context: ActorContext<M>) => Promise<S> | S

  /** Handles incoming messages. Returns the next state. */
  handler: (
    state: S,
    message: M,
    context: ActorContext<M>,
  ) => Promise<ActorResult<S>> | ActorResult<S>

  /** Reacts to lifecycle events (stopped, child-started, child-stopped, child-failed). */
  lifecycle?: (
    state: S,
    event: LifecycleEvent,
    context: ActorContext<M>,
  ) => Promise<ActorResult<S>> | ActorResult<S>

  /**
   * Supervision strategy applied when this actor's message handler throws.
   * - 'stop'     — stop the actor (default if omitted)
   * - 'restart'  — re-run setup with initial state, optionally bounded by maxRetries/withinMs
   * - 'escalate' — notify parent of failure and stop the actor
   */
  supervision?: SupervisionStrategy
}

// ─── Internal Actor Handle (used by parent/system to manage the actor) ───
export type InternalActorHandle<M = unknown> = {
  readonly ref: ActorRef<M>
  readonly stop: () => Promise<void>
}

// ─── Actor System ───
export type ActorSystem = {
  readonly spawn: <M, S>(
    name: string,
    def: ActorDef<M, S>,
    initialState: S,
  ) => ActorRef<M>
  readonly stop: (child: ActorIdentity) => void
  readonly shutdown: () => Promise<void>
}
