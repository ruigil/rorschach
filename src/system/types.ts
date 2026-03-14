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

// ─── Mailbox Backpressure ───
export type MailboxOverflowStrategy = 'drop-newest' | 'drop-oldest'

export type MailboxConfig = {
  /** Maximum number of messages the mailbox can hold. Omit for unbounded. */
  capacity?: number
  /** What to do when the mailbox is full. Default: 'drop-newest' */
  overflowStrategy?: MailboxOverflowStrategy
  /** Called when a message is dropped due to overflow. */
  onOverflow?: (dropped: unknown) => void
}

// ─── Mailbox ───
export type Mailbox<T> = {
  enqueue: (item: T) => void
  /** Enqueue an item bypassing capacity limits. Used for lifecycle/control events. */
  enqueueSystem: (item: T) => void
  take: () => Promise<T | Stop>
  close: () => void
  /** Current number of items in the mailbox queue. */
  readonly size: () => number
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

// ─── Event Stream Topics ───
export type EventTopic = string

// ─── Well-known system topics ───
export const DeadLetterTopic = 'system.deadLetters' as const
export const LogTopic = 'system.log' as const

// ─── Dead Letter ───
export type DeadLetter = {
  readonly recipient: string
  readonly message: unknown
  readonly timestamp: number
}

// ─── Log Event ───
export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export type LogEvent = {
  readonly level: LogLevel
  readonly source: string
  readonly message: string
  readonly data?: unknown
  readonly timestamp: number
}

// ─── Event Stream (System Pub-Sub Bus) ───
export type EventStream = {
  /** Publish an event to all subscribers of the given topic. */
  readonly publish: (topic: EventTopic, event: unknown) => void
  /** Subscribe to a topic. Matching events are delivered via the callback. */
  readonly subscribe: (
    subscriberName: string,
    topic: EventTopic,
    deliver: (event: unknown) => void,
  ) => void
  /** Unsubscribe from a specific topic. */
  readonly unsubscribe: (subscriberName: string, topic: EventTopic) => void
  /** Remove all subscriptions held BY this actor (called on stop). */
  readonly cleanup: (subscriberName: string) => void
  /** Remove the forward-map entry for a topic entirely (used when a watched actor dies). */
  readonly deleteTopic: (topic: EventTopic) => void
}

// ─── Message Handler (reusable handler function type) ───
export type MessageHandler<M, S> = (
  state: S,
  message: M,
  context: ActorContext<M>,
) => Promise<ActorResult<S>> | ActorResult<S>

// ─── Actor Result (returned from handlers) ───
//
// Discriminated union using `?: never` exclusion — makes illegal
// combinations (e.g. stash + become) a compile-time error while
// keeping the common case `{ state }` zero-boilerplate.
//
export type ActorResult<S> =
  // ─── Process: handle the message normally, optionally emit domain events ───
  | {
      state: S
      /** Domain events produced by this handler invocation. Auto-published to the actor's name topic on the EventStream. */
      events?: unknown[]
      become?: never
      stash?: never
      unstashAll?: never
    }
  // ─── Become: switch to a new message handler, optionally replay stashed messages ───
  | {
      state: S
      /** Replace the current message handler with a new one. */
      become: MessageHandler<any, S>
      /** Re-enqueue all stashed messages into the mailbox. Typically used alongside `become`. */
      unstashAll?: boolean
      /** Domain events produced by this handler invocation. */
      events?: unknown[]
      stash?: never
    }
  // ─── Stash: defer the current message for later reprocessing ───
  | {
      state: S
      /** Defer the current message for later reprocessing. */
      stash: true
      become?: never
      unstashAll?: never
      events?: never
    }

// ─── Lifecycle Result (returned from lifecycle handlers) ───
export type LifecycleResult<S> = { state: S }

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

  // ─── Event Stream (pub-sub) ───

  /** Publish an event to the system event bus under the given topic. */
  readonly publish: (topic: EventTopic, event: unknown) => void
  /** Subscribe to a topic. The adapter maps raw bus events into this actor's message type M. */
  readonly subscribe: (topic: EventTopic, adapter: (event: unknown) => M) => void
  /** Unsubscribe from a topic. */
  readonly unsubscribe: (topic: EventTopic) => void

  // ─── Async Effects ───

  /**
   * Run an async effect without blocking the actor's message loop.
   * When the promise settles, the adapted message is enqueued into
   * this actor's mailbox and processed sequentially like any other message.
   *
   * Uses `enqueueSystem` internally — piped results bypass backpressure,
   * matching the semantics of timer-scheduled messages.
   */
  readonly pipeToSelf: <T>(
    future: Promise<T>,
    onSuccess: (value: T) => M,
    onFailure: (error: unknown) => M,
  ) => void

  // ─── Logging ───

  readonly log: {
    readonly debug: (message: string, data?: unknown) => void
    readonly info: (message: string, data?: unknown) => void
    readonly warn: (message: string, data?: unknown) => void
    readonly error: (message: string, data?: unknown) => void
  }
}

// ─── Actor Definition (behavior specification) ───
export type ActorDef<M, S> = {
  /** Runs once on start (or restart). Receives initial state + context. Returns the enriched initial state. */
  setup?: (state: S, context: ActorContext<M>) => Promise<S> | S

  /** Handles incoming messages. Returns the next state. */
  handler: MessageHandler<M,S>

  /** Reacts to lifecycle events (stopped, terminated). */
  lifecycle?: (
    state: S,
    event: LifecycleEvent,
    context: ActorContext<M>,
  ) => Promise<LifecycleResult<S>> | LifecycleResult<S>

  /**
   * Supervision strategy applied when this actor's message handler throws.
   * - 'stop'     — stop the actor (default if omitted)
   * - 'restart'  — re-run setup with initial state, optionally bounded by maxRetries/withinMs
   */
  supervision?: SupervisionStrategy

  /**
   * Mailbox configuration for backpressure.
   * Omit for unbounded (default — current behavior).
   */
  mailbox?: MailboxConfig

  /**
   * Maximum number of messages that can be stashed.
   * When exceeded, the oldest stashed message is dropped to dead letters.
   * Default: 1000.
   */
  stashCapacity?: number
}

// ─── Stop Result (returned from InternalActorHandle.stop()) ───
export type StopResult = { reason: 'stopped' | 'failed'; error?: unknown }

// ─── Internal Actor Handle (used by parent/system to manage the actor) ───
export type InternalActorHandle<M = unknown> = {
  readonly ref: ActorRef<M>
  readonly stop: () => Promise<StopResult>
}

// ─── Registry (flat map of actor name → ActorRef) ───
export type Registry = {
  readonly register: (name: string, ref: ActorRef<unknown>) => void
  readonly unregister: (name: string) => void
  readonly lookup: <T = unknown>(name: string) => ActorRef<T> | undefined
}

// ─── Actor Services (shared system-level infrastructure passed to every actor) ───
export type ActorServices = {
  readonly registry: Registry
  readonly eventStream: EventStream
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

  // ─── Event Stream (external access) ───

  /** Publish an event to the system event bus from outside the actor world. */
  readonly publish: (topic: EventTopic, event: unknown) => void
  /** Subscribe to events from outside the actor world. Returns an unsubscribe function. */
  readonly subscribe: (
    subscriberName: string,
    topic: EventTopic,
    callback: (event: unknown) => void,
  ) => () => void
}
