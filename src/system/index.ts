// ─── Public API ───
export { createPluginSystem, type PluginSystemOptions } from './system.ts'
export { createWorkerBridge, taskTopic } from '../plugins/parallel/worker-bridge.ts'
export type { TaskEvent, WorkerBridge, WorkerBridgeMsg, WorkerBridgeOptions, WorkerBridgeState } from '../plugins/parallel/worker-bridge.ts'
export { ask } from './ask.ts'
export { onLifecycle, onMessage } from './match.ts'
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
  // ─── Plugins ───
  PluginDef,
  LoadedPlugin,
  LoadResult,
  UnloadResult,
  PluginSystem,
} from './types.ts'
