// ─── Public API ───
export { AgentSystem, type PluginSystemOptions } from './actor/system.ts'
export { ask } from './actor/ask.ts'
export { invokeTool, defineTool, parseToolArgs, applyToolFilter } from './agent/tool-utils.ts'
export type { InvokeToolArgs, InvokeToolOptions } from './agent/tool-utils.ts'
export { onLifecycle, onMessage } from './actor/match.ts'
export { watchTopic } from './actor/services.ts'

// ─── Config utilities ───
export {
  defineConfig,
  buildConfigRoute,
  publishConfigSurface,
  deleteConfigSurface,
  deepMerge,
  createSlot,
  spawnSlot,
  stopSlot,
  stopAllSlots,
  type ConfigOptions,
  type ConfigDescriptor,
  type ActorSlot,
} from './actor/config.ts'

// ─── Agent Loop & Context Assembly Helpers ───
export {
  agentLoop,
  idleLoopState,
  idleGuardInterceptor,
  type LoopMsg,
  type LoopState,
  type WithLoopState,
  type LoopTurn,
  type LoopPendingBatch,
  type LoopStartTurnParams,
  type LoopToolResultMsg,
  type LoopBaseMsg,
  type LoopError,
  type StreamChunk,
  type AgentLoopHooks,
  type AgentLoopHandle,
} from './agent/agent-loop.ts'

export {
  assembleAgentMessages,
  type ContextView,
  type ContextAssemblyPolicy,
} from './agent/context-assembly.ts'

export { TraceTopic } from './actor/types.ts'
export type { TraceSpan } from './actor/types.ts'
export type { SpanHandle } from './actor/types.ts'

export {
  DeadLetterTopic,
  LogTopic,
  MetricsTopic,
  SystemLifecycleTopic,
  createTopic,
  emit,
  redact,
} from './actor/types.ts'

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
} from './actor/types.ts'
