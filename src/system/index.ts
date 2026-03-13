// ─── Public API ───
export { createActorSystem, type SystemLifecycleHandler } from './system.ts'
export { ask } from './ask.ts'
export { watchTopic } from './eventstream.ts'

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
  DeadLetter,
  EventStream,
  EventTopic,
  LifecycleEvent,
  LogEvent,
  LogLevel,
  Registry,
  SupervisionStrategy,
  Timers,
  TimerKey,
} from './types.ts'
