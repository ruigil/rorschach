import type { ActorContext, ActorDef, ActorRef } from './types.ts'

// ─── Config Descriptor ──────────────────────────────────────────────────────
//
// Unified config descriptor for plugins. Replaces the repeated
// `configDescriptor` + `onConfigChange` boilerplate in every plugin.
//
// Usage:
//   const config = defineConfig<MyConfig>('my-plugin', { /* defaults */ })
//   // Then in PluginDef:
//   configDescriptor: config,
//
export type ConfigDescriptor<C> = {
  readonly key: string
  readonly defaults: C
  readonly onConfigChange: (config: C) => { type: 'config'; slice: C }
}

export const defineConfig = <C>(id: string, defaults: C): ConfigDescriptor<C> => ({
  key: id,
  defaults,
  onConfigChange: (config: C) => ({ type: 'config' as const, slice: config }),
})

// ─── Actor Slot ─────────────────────────────────────────────────────────────
//
// Tracks a single config-managed child actor: its config, ref, and generation
// counter. Replaces the inconsistent PluginActorState<C> pattern.
//
// Use ActorSlot<never> for actors with no config (uniform pattern).
//
export type ActorSlot<C = unknown> = {
  config: C | null
  ref: ActorRef<any> | null
  gen: number
}

/** Creates an empty actor slot. */
export const createSlot = <C = unknown>(): ActorSlot<C> => ({
  config: null,
  ref: null,
  gen: 0,
})

/**
 * Stop the previous actor (if any), spawn a new one with incremented gen.
 * Returns a new slot with the updated config, ref, and gen.
 */
export const spawnSlot = <C>(
  ctx: ActorContext<any>,
  slot: ActorSlot<C>,
  name: string,
  factory: (config: C) => ActorDef<any, any>,
  config: C,
): ActorSlot<C> => {
  const gen = slot.gen + 1
  if (slot.ref) ctx.stop(slot.ref)
  const ref = ctx.spawn(`${name}-${gen}`, factory(config))
  return { config, ref, gen }
}

/** Stop the actor in a slot (if any). */
export const stopSlot = (ctx: ActorContext<any>, slot: ActorSlot<any>): void => {
  if (slot.ref) ctx.stop(slot.ref)
}

/** Stop all actors in a record of slots. */
export const stopAllSlots = (
  ctx: ActorContext<any>,
  slots: Record<string, ActorSlot<any>>,
): void => {
  for (const slot of Object.values(slots)) {
    if (slot.ref) ctx.stop(slot.ref)
  }
}

// ─── Shared Refs ────────────────────────────────────────────────────────────
//
// Formalizes the closure-captured mutable refs pattern used by plugins that
// register HTTP routes (memory, notebook, googleapis). Route handlers are
// plain async functions — they need stable references to actor refs that
// survive actor restarts.
//
// Usage:
//   const refs = createSharedRefs({ kgraphRef: null as ActorRef<KgraphMsg> | null })
//   // In lifecycle.start:
//   refs.update({ kgraphRef: newRef })
//   // In route handler:
//   const kgraphRef = refs.current.kgraphRef
//
export type SharedRefs<T extends Record<string, any>> = {
  readonly current: T
  readonly update: (patch: Partial<T>) => void
}

export const createSharedRefs = <T extends Record<string, any>>(initial: T): SharedRefs<T> => {
  const refs = { ...initial }
  return {
    get current() { return refs },
    update(patch: Partial<T>) { Object.assign(refs, patch) },
  }
}
