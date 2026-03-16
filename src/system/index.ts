// ─── Public API ───
export { createPluginSystem, type PluginSystemOptions } from './system.ts'
export { createWorkerBridge, taskTopic } from '../actors/worker-bridge.ts'
export type { TaskEvent, WorkerBridge, WorkerBridgeMsg, WorkerBridgeOptions, WorkerBridgeState } from '../actors/worker-bridge.ts'
export { ask } from './ask.ts'
export { watchTopic } from './services.ts'

export {
  DeadLetterTopic,
  LogTopic,
  MetricsTopic,
  SystemLifecycleTopic,
  createTopic,
  emit,
} from './types.ts'

export type {
  ActorRef,
  MessageHeaders,
  ActorDef,
  ActorContext,
  ActorIdentity,
  ActorResult,
  Interceptor,
  LifecycleResult,
  DeadLetter,
  EventStream,
  EventTopic,
  LifecycleEvent,
  LogEvent,
  LogLevel,
  MailboxConfig,
  MailboxOverflowStrategy,
  MessageHandler,
  PersistenceAdapter,
  Registry,
  ShutdownConfig,
  SupervisionStrategy,
  Timers,
  TimerKey,
  TypedEvent,
  // ─── Metrics / Introspection ───
  ActorMetrics,
  ActorSnapshot,
  ActorStatus,
  ActorTreeNode,
  MetricsEvent,
  MetricsRegistry,
  ProcessingTime,
} from './types.ts'

export type {
  PluginDef,
  PluginHandle,
  PluginSource,
  LoadedPlugin,
  LoadResult,
  UnloadResult,
  PluginSystem,
} from '../plugins/index.ts'
