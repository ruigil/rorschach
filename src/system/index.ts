// ─── Public API ───
export { AgentSystem } from './actor/system.ts'
export { ask } from './actor/ask.ts'
export { invokeTool, defineTool, parseToolArgs, applyToolFilter } from './agent/tool-utils.ts'
export { onLifecycle, onMessage } from './actor/match.ts'
export { watchTopic } from './actor/services.ts'
export { createPluginFactory } from './factory.ts'
export { resolvePersistence, persistencePluginAdapter  } from './persistence.ts'
export {
  type MessageRequest,
  createMessageRequest,
  encodeMessageRequest,
  decodeMessageRequest,
  isMessageRequest,
  requestStorage,
} from './context/request.ts'

// ─── Config utilities ───
export {
  defineConfig,
  publishConfigSurface,
  deleteConfigSurface,
  deepMerge,
  createSlot,
  spawnSlot,
  stopSlot,
  stopAllSlots,
} from './actor/config.ts'

// ─── Agent Loop & Context Assembly Helpers ───
export {
  agentLoop,
  idleLoopState,
  idleGuardInterceptor,
  type LoopMsg,
  type LoopState,
  type WithLoopState,
  type LoopStartTurnParams,
  type AgentLoopHandle,
} from './agent/agent-loop.ts'

export {
  assembleAgentMessages,
  assembleUserText,
  getTodayDateString,
  getUserTimeContext,
  isValidTimezone,
  type ContextView,
} from './agent/context-assembly.ts'

export { DynamicAgentActor } from './agent/dynamic-agent.ts'

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

export type {
  ActorRef,
  ActorServices,
  ActorDef,
  ActorContext,
  ActorIdentity,
  ActorResult,
  Interceptor,
  DeadLetter,
  EventTopic,
  LifecycleEvent,
  WatchStatusEvent,
  LogEvent,
  MessageHandler,
  PersistenceAdapter,
  MetricsEvent,
  PluginDef,
  PluginSystem,
  LoadedPlugin,
  SystemControl,
  ActualSnapshot,
  Op,
  OpResult,
} from './actor/types.ts'

// ─── Node control / config source ───
export {
  fileSource,
  resolveConfigPath,
  staticSource,
} from './node/config-sources.ts'
export {
  type ConfigSource,
  type DesiredState,
  type DesiredStatePatch,
  type PluginEntry,
  type ObservedState,
  type ObservedPlugin,
} from './node/types.ts'

export type {
  HealthStatus,
  ActorHealth,
  WatchStatus,
} from '../types/health.ts'
