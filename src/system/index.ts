// ─── Public API ───
export { createActorSystem, type SystemLifecycleHandler, type ActorSystemOptions } from './system.ts'
export { ask } from './ask.ts'
export { watchTopic } from './services.ts'

export {
  DeadLetterTopic,
  LogTopic,
} from './types.ts'

export type {
  ActorRef,
  ActorDef,
  ActorContext,
  ActorIdentity,
  ActorResult,
  ActorSystem,
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
} from './types.ts'
