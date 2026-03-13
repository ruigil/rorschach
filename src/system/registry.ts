import type { ActorRef, Registry } from './types.ts'

/**
 * Creates the actor registry: a flat map of actor name → ActorRef.
 *
 * Every actor registers itself after setup completes and unregisters on stop.
 * Used by `context.lookup()` to find actors by name.
 */
export const createRegistry = (): Registry => {
  const actors = new Map<string, ActorRef<unknown>>()

  const register = (name: string, ref: ActorRef<unknown>): void => {
    actors.set(name, ref)
  }

  const unregister = (name: string): void => {
    actors.delete(name)
  }

  const lookup = <T = unknown>(name: string): ActorRef<T> | undefined => {
    return actors.get(name) as ActorRef<T> | undefined
  }

  return { register, unregister, lookup }
}
