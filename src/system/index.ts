// ─── Public API ───
export { createActorSystem, type ActorSystemOptions } from './system.ts'
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
  ActorDef,
  ActorContext,
  ActorIdentity,
  ActorResult,
  ActorSystem,
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
