// ─── Sentinel for mailbox close ───
export const STOP = Symbol('STOP')
export type Stop = typeof STOP

// ─── Message Headers (envelope metadata for cross-actor propagation) ───
//
// Plain string map — compatible with W3C traceparent/tracestate/baggage and
// any other propagation format. The library threads headers through envelopes,
// pipeToSelf, and stash/unstash without interpreting their contents.
//
export type MessageHeaders = Record<string, string>

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
  /**
   * Switch to drain mode: stop accepting new messages via `enqueue()`,
   * but continue delivering buffered messages. `enqueueSystem()` still works.
   * Once the queue is empty, `take()` returns STOP instead of suspending.
   */
  drain: () => void
  /** Current number of items in the mailbox queue. */
  readonly size: () => number
}

// ─── Actor Reference (opaque handle) ───
export type ActorRef<M> = {
  readonly name: string
  readonly send: (message: M, headers?: MessageHeaders) => void
  readonly isAlive: () => boolean
}

// ─── Minimal reference (used where we only need identity, not send) ───
export type ActorIdentity = { readonly name: string }

// ─── Supervision Strategy ───
export type SupervisionStrategy =
  | { type: 'stop' }
  | {
      type: 'restart'
      maxRetries?: number
      withinMs?: number
      /**
       * Initial backoff delay (in ms) before the first restart.
       * Each subsequent consecutive failure doubles the delay.
       * Omit for immediate restart (existing behavior).
       */
      backoffMs?: number
      /**
       * Maximum backoff delay (in ms). Caps the exponential growth.
       * Only meaningful when `backoffMs` is set.
       */
      maxBackoffMs?: number
    }

// ─── Lifecycle Events ───
export type LifecycleEvent =
  | { type: 'start' }
  | { type: 'stopping' }
  | { type: 'stopped' }
  | { type: 'terminated'; ref: ActorIdentity; reason: 'stopped' | 'failed'; error?: unknown }

// ─── Tracing ───

export type SpanHandle = {
  readonly traceId: string
  readonly spanId: string
  /** Close the span as successful. */
  done(data?: Record<string, unknown>): void
  /** Close the span as failed. */
  error(err?: unknown): void
}

export type TraceContext = {
  /** Start a new root span (generates a new traceId). */
  start(operation: string, data?: Record<string, unknown>): SpanHandle
  /** Start a child span under an existing trace. */
  child(traceId: string, parentSpanId: string, operation: string, data?: Record<string, unknown>): SpanHandle
  /** Parse W3C traceparent from the current message's headers. Returns null if absent. */
  fromHeaders(): { traceId: string; spanId: string } | null
  /** Produce W3C traceparent headers to propagate to downstream send()/ask() calls. */
  injectHeaders(span: SpanHandle): MessageHeaders
}

// ─── Event Stream Topics ───
//
// EventTopic<T> carries a phantom type parameter that encodes the payload type.
// The phantom field is optional and never set at runtime — it exists only for the
// type checker to enforce publish/subscribe type safety. Plain strings are still
// assignable (they default to EventTopic<unknown>), so existing code compiles
// unchanged and can be migrated incrementally to createTopic<T>().
//
export type EventTopic<T = unknown> = string & { readonly __eventType?: T }

/** Creates a typed event topic. The phantom type T encodes the payload type at compile time — zero runtime cost. */
export const createTopic = <T>(name: string): EventTopic<T> => name as EventTopic<T>

// ─── Well-known system topics (typed) ───
export const DeadLetterTopic: EventTopic<DeadLetter> = 'system.deadLetters' as EventTopic<DeadLetter>
export const LogTopic: EventTopic<LogEvent> = 'system.log' as EventTopic<LogEvent>
export const SystemLifecycleTopic: EventTopic<LifecycleEvent> = 'system.lifecycle' as EventTopic<LifecycleEvent>
export const MetricsTopic: EventTopic<MetricsEvent> = 'system.metrics' as EventTopic<MetricsEvent>

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

// ─── Typed Event (topic + payload pair for handler-returned events) ───
//
// Each TypedEvent carries an explicit topic, so the processing loop publishes
// to the correct topic with compile-time type safety. The `emit` helper
// enforces that the payload matches the topic's phantom type.
//

/** A topic + payload pair. Used in `ActorResult.events` for type-safe domain event publishing. */
export type TypedEvent<T = any> = {
  readonly topic: EventTopic<T>
  readonly payload: T
}

/** Creates a TypedEvent — enforces that the payload matches the topic's phantom type T. */
export const emit = <T>(topic: EventTopic<T>, payload: T): TypedEvent<T> =>
  ({ topic, payload })

// ─── Event Stream (System Pub-Sub Bus) ───
//
// The generic overloads on publish/subscribe enforce payload type safety
// when a typed EventTopic<T> is used. The runtime implementation is unchanged —
// the internal maps still store `unknown` callbacks. Type safety is purely
// compile-time via the phantom type on EventTopic<T>.
//
export type TopicSnapshot = {
  readonly topic: string
  readonly subscribers: string[]
}

export type EventStream = {
  /** Publish an event to all subscribers of the given topic. */
  readonly publish: <T>(topic: EventTopic<T>, event: T) => void
  /** Publish and retain: stores event under (topic, key) and delivers to current subscribers. New subscribers receive all retained values immediately on subscribe. */
  readonly publishRetained: <T>(topic: EventTopic<T>, key: string, event: T) => void
  /** Remove a retained entry and publish the tombstone event to current subscribers. */
  readonly deleteRetained: <T>(topic: EventTopic<T>, key: string, tombstone: T) => void
  /** Subscribe to a topic. Matching events are delivered via the callback. */
  readonly subscribe: <T>(
    subscriberName: string,
    topic: EventTopic<T>,
    deliver: (event: T) => void,
  ) => void
  /** Unsubscribe from a specific topic. */
  readonly unsubscribe: (subscriberName: string, topic: EventTopic) => void
  /** Remove all subscriptions held BY this actor (called on stop). */
  readonly cleanup: (subscriberName: string) => void
  /** Remove the forward-map entry for a topic entirely (used when a watched actor dies). */
  readonly deleteTopic: (topic: EventTopic) => void
  /** Returns a point-in-time snapshot of all topics and their subscriber names. */
  readonly snapshot: () => TopicSnapshot[]
}

// ─── Message Handler (reusable handler function type) ───
//
// Handlers are synchronous — they return the next state immediately.
// For async work, use `context.pipeToSelf()` to run a Promise and
// route the result back as a regular message.
//
export type MessageHandler<M, S> = (
  state: S,
  message: M,
  context: ActorContext<M>,
) => ActorResult<M, S>

// ─── Interceptor (wraps message processing) ───
//
// An interceptor receives the same (state, message, context) tuple as a handler,
// plus a `next` function to continue the pipeline. It can:
//   - inspect/transform the message before the handler sees it
//   - delegate to `next(state, message)` to continue processing
//   - inspect/transform the result after the handler returns
//   - short-circuit by returning an ActorResult without calling `next`
//
// Interceptors are structural — they survive `become` switches and reset on restart.
//
export type Interceptor<M, S> = (
  state: S,
  message: M,
  context: ActorContext<M>,
  next: (state: S, message: M) => ActorResult<M, S>,
) => ActorResult<M, S>
// keeping the common case `{ state }` zero-boilerplate.
//
export type ActorResult<M, S> =
  // ─── Process: handle the message normally, optionally emit domain events ───
  | {
      state: S
      /** Typed domain events produced by this handler invocation. Each event is published to its declared topic on the EventStream. Use `emit(topic, payload)` to construct. */
      events?: TypedEvent[]
      become?: never
      stash?: never
      unstashAll?: never
    }
  // ─── Become: switch to a new message handler, optionally replay stashed messages ───
  | {
      state: S
      /** Replace the current message handler with a new one. */
      become: MessageHandler<M, S>
      /** Re-enqueue all stashed messages into the mailbox. Typically used alongside `become`. */
      unstashAll?: boolean
      /** Typed domain events produced by this handler invocation. */
      events?: TypedEvent[]
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
  /** Returns the headers attached to the message currently being processed. Empty object when not set. */
  readonly messageHeaders: () => MessageHeaders
  /**
   * Config slice injected at spawn time by the plugin system.
   * Cast to your plugin's config type: `ctx.config as MyPluginConfig`.
   * Always reflects the latest value — updated in place when `system.updateConfig()` is called.
   */
  readonly config: unknown
  readonly spawn: <CM, CS>(
    name: string,
    def: ActorDef<CM, CS>,
    initialState: CS,
    options?: { config?: unknown },
  ) => ActorRef<CM>
  readonly stop: (child: ActorIdentity) => void
  /** Register interest in another actor's termination. Delivers a `terminated` lifecycle event when the target dies. */
  readonly watch: (target: ActorRef<unknown>) => void
  /** Remove a previously registered watch. */
  readonly unwatch: (target: ActorRef<unknown>) => void
  // ─── Event Stream (pub-sub) ───

  /** Publish a typed event to the system event bus under the given topic. */
  readonly publish: <T>(topic: EventTopic<T>, event: T) => void
  /** Publish and retain: stores event under (topic, key) and replays to new subscribers. */
  readonly publishRetained: <T>(topic: EventTopic<T>, key: string, event: T) => void
  /** Remove a retained entry and publish the tombstone to current subscribers. */
  readonly deleteRetained: <T>(topic: EventTopic<T>, key: string, tombstone: T) => void
  /** Subscribe to a typed topic. The adapter maps bus events (typed T) into this actor's message type M. */
  readonly subscribe: <T>(topic: EventTopic<T>, adapter: (event: T) => M) => void
  /** Unsubscribe from a topic. */
  readonly unsubscribe: (topic: EventTopic) => void
  /** Remove a topic's subscriber map entry. Call after publishing a terminal event on a short-lived topic to prevent accumulation. */
  readonly deleteTopic: (topic: EventTopic) => void

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

  // ─── Introspection ───

  /** Returns point-in-time snapshots of all currently registered actors. */
  readonly actorSnapshots: () => ActorSnapshot[]
  /** Returns a point-in-time snapshot of all topics and their subscribers on the event stream. */
  readonly topicSnapshots: () => TopicSnapshot[]

  // ─── Logging ───

  readonly log: {
    readonly debug: (message: string, data?: unknown) => void
    readonly info: (message: string, data?: unknown) => void
    readonly warn: (message: string, data?: unknown) => void
    readonly error: (message: string, data?: unknown) => void
  }
  readonly trace: TraceContext
}

// ─── Shutdown Configuration ───
export type ShutdownConfig = {
  /**
   * Drain remaining mailbox messages before stopping.
   * When true, the actor processes all queued messages and receives a
   * `stopping` lifecycle event before the final `stopped` phase.
   * Default: false (immediate stop — existing behavior).
   */
  drain?: boolean
  /**
   * Maximum time (in ms) to wait for drain to complete.
   * If the drain hasn't finished by this deadline, the mailbox is force-closed.
   * Only meaningful when `drain` is true.
   */
  timeoutMs?: number
}

// ─── Persistence Adapter ───
export type PersistenceAdapter<S> = {
  /**
   * Called during actor startup (before the `start` lifecycle event).
   * Return the last saved snapshot, or undefined to start from initialState.
   * Errors propagate as startup failures.
   */
  load: () => Promise<S | undefined>
  /**
   * Called after each successfully processed message with the new state.
   * Awaited before the next message is dequeued — guarantees at-least-once
   * durability at the cost of throughput. Errors are caught, logged as warnings,
   * and do not crash the actor.
   */
  save: (state: S) => Promise<void>
}

// ─── Actor Definition (behavior specification) ───
export type ActorDef<M, S> = {
  /** Handles incoming messages. Returns the next state. */
  handler: MessageHandler<M,S>

  /** Reacts to lifecycle events (stopping, stopped, terminated). */
  lifecycle?: (
    state: S,
    event: LifecycleEvent,
    context: ActorContext<M>,
  ) => Promise<LifecycleResult<S>> | LifecycleResult<S>

  /**
   * Supervision strategy applied when this actor's message handler throws.
   * - 'stop'     — stop the actor (default if omitted)
   * - 'restart'  — deliver the `start` lifecycle event with initial state, optionally bounded by maxRetries/withinMs
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

  /**
   * Shutdown behavior configuration.
   * Enables graceful shutdown with mailbox drain and optional timeout.
   * Omit for immediate stop (default — existing behavior).
   */
  shutdown?: ShutdownConfig

  /**
   * Interceptors applied in order around the message handler.
   * Each interceptor wraps the next, forming a pipeline. The first
   * interceptor in the array is the outermost wrapper; the last is
   * closest to the handler.
   *
   * Interceptors are structural — they survive `become` switches
   * (the new handler is re-wrapped) and reset on supervision restart.
   *
   * Omit for direct handler invocation (default — zero overhead).
   */
  interceptors?: Interceptor<M, S>[]

  /**
   * Persistence adapter for state snapshots.
   *
   * When provided, `load()` is called before the `start` lifecycle event on every
   * start and restart — so the `start` handler always receives the last durable
   * state and can re-initialize non-serializable resources (connections,
   * subscriptions, timers) on top of it.
   *
   * `save(state)` is called after every successfully processed message.
   * Save errors are logged as warnings and do not crash or restart the actor.
   *
   * Note: stash contents and the active `become` variant are not persisted.
   * Behavioral state that must survive restarts should be encoded in S.
   */
  persistence?: PersistenceAdapter<S>

  /**
   * Called instead of raw state when producing an ActorSnapshot for metrics.
   * Use to redact secrets (API keys, passwords) before state reaches the UI.
   * Use `redact()` as a placeholder value for sensitive fields.
   */
  maskState?: (state: S) => unknown
}

/** Replaces a sensitive value with a safe placeholder in metrics snapshots. */
export const redact = (): string => '[redacted]'

// ─── Stop Result (returned from InternalActorHandle.stop()) ───
export type StopResult = { reason: 'stopped' | 'failed'; error?: unknown }

// ─── Internal Actor Handle (used by parent/system to manage the actor) ───
export type InternalActorHandle<M = unknown> = {
  readonly ref: ActorRef<M>
  readonly stop: () => Promise<StopResult>
}

// ─── Actor Metrics Types ───

export type ActorStatus = 'running' | 'stopping' | 'stopped' | 'failed'

export type ProcessingTime = {
  readonly count: number
  readonly sum: number
  readonly min: number
  readonly max: number
  readonly avg: number
}

/** Point-in-time snapshot of a single actor's metrics. */
export type ActorSnapshot = {
  readonly name: string
  readonly status: ActorStatus
  readonly uptime: number
  readonly messagesReceived: number
  readonly messagesProcessed: number
  readonly messagesFailed: number
  readonly restartCount: number
  readonly mailboxSize: number
  readonly stashSize: number
  readonly childCount: number
  readonly lastMessageTimestamp: number | null
  readonly processingTime: ProcessingTime
  readonly children: string[]
  readonly state?: unknown
}

/** Hierarchical tree node for actor tree introspection. */
export type ActorTreeNode = {
  readonly name: string
  readonly status: ActorStatus
  readonly children: readonly ActorTreeNode[]
}

/** Per-actor metrics collector (internal — created by createActor). */
export type ActorMetrics = {
  readonly recordMessageReceived: () => void
  readonly recordMessageProcessed: (durationMs: number) => void
  readonly recordMessageFailed: () => void
  readonly recordRestart: () => void
  readonly setStatus: (status: ActorStatus) => void
  readonly snapshot: () => ActorSnapshot
}

/** System-level metrics registry. */
export type MetricsRegistry = {
  readonly register: (name: string, metrics: ActorMetrics) => void
  readonly unregister: (name: string) => void
  readonly snapshot: (name: string) => ActorSnapshot | undefined
  readonly snapshotAll: () => ActorSnapshot[]
  readonly actorTree: () => ActorTreeNode[]
}

/** Event published to MetricsTopic by the internal metrics actor. */
export type MetricsEvent = {
  readonly timestamp: number
  readonly actors: ActorSnapshot[]
  readonly topics: TopicSnapshot[]
}

// ─── Actor Services (shared system-level infrastructure passed to every actor) ───
export type ActorServices = {
  readonly eventStream: EventStream
  readonly metricsRegistry: MetricsRegistry
}

// ─── Plugin Definition ───
//
// A PluginDef is an ActorDef<M, S> augmented with plugin metadata.
// The plugin root IS the actor — lifecycle.start activates, lifecycle.stopped
// deactivates.
//
// The optional type parameter C describes the plugin's config slice shape.
// When configDescriptor is provided, the system merges plugin defaults with
// user-supplied overrides and injects the result into the plugin actor's
// ctx.config at spawn time. Use `ctx.config as C` inside handlers.
//
/**
 * Tracks the lifecycle state of a single child actor managed by a plugin.
 * Stores the current config slice, a reference to the running actor, and a
 * generation counter used to produce unique spawn names on reconfiguration.
 */
export type PluginActorState<C> = {
  config: C | null
  ref: ActorIdentity | null
  gen: number
}

export type PluginDef<M, S = unknown, C = unknown> = ActorDef<M, S> & {
  readonly id: string
  readonly version: string
  readonly precedes?: readonly string[]
  readonly description?: string
  readonly initialState: S
  readonly configDescriptor?: {
    /** Default config values for this plugin. Merged with user-supplied overrides. */
    readonly defaults: C
    /** Key in the global config tree. Defaults to the plugin's id. */
    readonly key?: string
    /**
     * Maps an updated config slice to a plugin message, enabling reactive config updates.
     * Called by `system.updateConfig()` when the plugin's config slice changes.
     * The returned message is sent to the plugin actor.
     */
    readonly onConfigChange?: (config: C) => M
  }
}

// ─── Loaded Plugin (runtime state) ───
export type LoadedPlugin = {
  readonly id: string
  readonly version: string
  readonly precedes: readonly string[]
  readonly def: PluginDef<any, any, any>
  readonly status: 'loading' | 'active' | 'deactivating' | 'failed'
  readonly error?: unknown
  readonly loadedAt: number
  /** Live ref to the plugin actor. Used by updateConfig() to deliver config-change messages. */
  readonly ref?: ActorRef<any>
}

// ─── Load / Unload Results ───
export type LoadResult = { ok: true; id: string } | { ok: false; error: string }
export type UnloadResult = { ok: true } | { ok: false; error: string }

// ─── Plugin System (ActorSystem merged with plugin management) ───
export type PluginSystem = {
  // ─── Actor management ───
  readonly spawn: <M, S>(name: string, def: ActorDef<M, S>, initialState: S) => ActorRef<M>
  readonly stop: (child: ActorIdentity) => void
  readonly shutdown: () => Promise<void>

  // ─── Event Stream ───
  readonly publish: <T>(topic: EventTopic<T>, event: T) => void
  readonly publishRetained: <T>(topic: EventTopic<T>, key: string, event: T) => void
  readonly subscribe: <T>(
    topic: EventTopic<T>,
    callback: (event: T) => void,
  ) => () => void

  // ─── Config management ───
  /**
   * Deep-merges the provided patch into the global config tree.
   * For each loaded plugin whose config slice changed, delivers a config-change
   * message via the plugin's `configDescriptor.onConfigChange` factory (if defined).
   */
  readonly updateConfig: (patch: Record<string, unknown>) => void

  // ─── Plugin management ───
  readonly use: (def: PluginDef<any, any, any>) => Promise<LoadResult>
  readonly unloadPlugin: (id: string) => Promise<UnloadResult>
  readonly reloadPlugin: (id: string) => Promise<LoadResult>
  readonly hotReloadPlugin: (id: string, path: string) => Promise<LoadResult>
  readonly listPlugins: () => LoadedPlugin[]
  readonly getPluginStatus: (id: string) => LoadedPlugin | undefined
}
