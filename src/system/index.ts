// ─── Public API ───
export { AgentSystem, type PluginSystemOptions } from './system.ts'
export { ask } from './ask.ts'
export { invokeTool, defineTool, parseToolArgs, applyToolFilter } from './tool-utils.ts'
export type { InvokeToolArgs, InvokeToolOptions } from './tool-utils.ts'
export { onLifecycle, onMessage } from './match.ts'
export { watchTopic } from './services.ts'

// ─── Config utilities ───
export {
  defineConfig,
  buildConfigRoute,
  publishConfigSurface,
  deleteConfigSurface,
  createSlot,
  spawnSlot,
  stopSlot,
  stopAllSlots,
  type ConfigOptions,
  type ConfigDescriptor,
  type ActorSlot,
} from './plugin-config.ts'

export { TraceTopic } from '../types/trace.ts'
export type { TraceSpan } from '../types/trace.ts'
export type { SpanHandle } from './types.ts'

export {
  DeadLetterTopic,
  LogTopic,
  MetricsTopic,
  SystemLifecycleTopic,
  createTopic,
  emit,
} from './types.ts'

export { ConfigSchemaTopic, ConfigUpdateRequestTopic } from '../types/config.ts'
export type { ConfigSchemaSection, ConfigUpdateRequest } from '../types/config.ts'

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
