// ─── Public API ───
export { createActorSystem, type SystemLifecycleHandler} from './system.ts'

export type {
  ActorRef,
  ActorDef,
  ActorContext,
  ActorIdentity,
  ActorResult,
  ActorSystem,
  LifecycleEvent,
  SupervisionStrategy,
} from './types.ts'
