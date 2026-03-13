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

// ─── Lifecycle Events ───
export type LifecycleEvent =
  | { type: 'stopped' }
  | { type: 'terminated'; ref: ActorIdentity; reason: 'stopped' | 'failed'; error?: unknown }

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
  /** Register interest in another actor's termination. Delivers a `terminated` lifecycle event when the target dies. */
  readonly watch: (target: ActorIdentity) => void
  /** Remove a previously registered watch. */
  readonly unwatch: (target: ActorIdentity) => void
  /** Look up an actor ref by its full hierarchical name. Returns undefined if not registered. */
  readonly lookup: <T = unknown>(name: string) => ActorRef<T> | undefined
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

  /** Reacts to lifecycle events (stopped, terminated). */
  lifecycle?: (
    state: S,
    event: LifecycleEvent,
    context: ActorContext<M>,
  ) => Promise<ActorResult<S>> | ActorResult<S>

  /**
   * Supervision strategy applied when this actor's message handler throws.
   * - 'stop'     — stop the actor (default if omitted)
   * - 'restart'  — re-run setup with initial state, optionally bounded by maxRetries/withinMs
   */
  supervision?: SupervisionStrategy
}

// ─── Internal Actor Handle (used by parent/system to manage the actor) ───
export type InternalActorHandle<M = unknown> = {
  readonly ref: ActorRef<M>
  readonly stop: () => Promise<void>
}

// ─── Actor Services (shared system-level infrastructure passed to every actor) ───
export type ActorServices = {
  readonly registry: {
    readonly register: (name: string, ref: ActorRef<unknown>) => void
    readonly unregister: (name: string) => void
    readonly lookup: <T = unknown>(name: string) => ActorRef<T> | undefined
  }
  readonly watchService: {
    /** Register watcher interest in target. notify is called when target terminates. */
    readonly watch: (watcherName: string, targetName: string, notify: (event: LifecycleEvent) => void) => void
    /** Remove a specific watch. */
    readonly unwatch: (watcherName: string, targetName: string) => void
    /** Remove all watches held BY this actor (called when actor stops). */
    readonly cleanup: (actorName: string) => void
    /** Notify all watchers that this actor has terminated. */
    readonly notifyWatchers: (actorName: string, reason: 'stopped' | 'failed', error?: unknown) => void
  }
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
