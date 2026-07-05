import type { ActorContext, ActorDef, ActorRef } from './types.ts'
import { type ConfigSchemaSection } from '../../types/config.ts'
import { RouteRegistrationTopic, type RouteRegistration } from '../../types/routes.ts'
import { OutboundAdminBroadcastTopic } from '../../types/events.ts'

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
  readonly schemas?: readonly ConfigSchemaSection[]
  readonly onConfigChange: (config: C) => { type: 'config'; slice: C }
}

export type ConfigOptions = {
  readonly schemas?: readonly ConfigSchemaSection[]
}

export const defineConfig = <C>(
  id: string,
  defaults: C,
  options?: ConfigOptions,
): ConfigDescriptor<C> => ({
  key: id,
  defaults,
  ...(options?.schemas !== undefined ? { schemas: options.schemas } : {}),
  onConfigChange: (config: C) => ({ type: 'config' as const, slice: config }),
})

export const buildConfigRoute = <C>(
  descriptor: ConfigDescriptor<C>,
  getConfig: () => C | undefined,
): RouteRegistration[] => [{
  id: `config.${descriptor.key}`,
  method: 'GET',
  path: `/config/${descriptor.key}`,
  handler: () => {
    const slice = getConfig()
    return new Response(JSON.stringify(slice ?? {}), {
      headers: { 'Content-Type': 'application/json' },
    })
  },
}]

export const publishConfigSurface = <C>(
  ctx: ActorContext<any>,
  descriptor: ConfigDescriptor<C>,
  getConfig: () => C | undefined,
): void => {
  for (const section of descriptor.schemas ?? []) {
    ctx.publishRetained(OutboundAdminBroadcastTopic, section.id, {
      type: 'config.schema',
      key: section.id,
      payload: { section },
    })
  }
  for (const reg of buildConfigRoute(descriptor, getConfig)) {
    ctx.publishRetained(RouteRegistrationTopic, reg.id, reg)
  }
}

export const deleteConfigSurface = <C>(
  ctx: ActorContext<any>,
  descriptor: ConfigDescriptor<C>,
): void => {
  for (const section of descriptor.schemas ?? []) {
    ctx.deleteRetained(OutboundAdminBroadcastTopic, section.id, {
      type: 'config.schema',
      key: section.id,
      payload: { section: { ...section, schema: null } },
      isTombstone: true,
    })
  }
  for (const reg of buildConfigRoute(descriptor, () => undefined)) {
    ctx.deleteRetained(RouteRegistrationTopic, reg.id, {
      id: reg.id,
      method: reg.method,
      path: reg.path,
      ...(reg.match !== undefined ? { match: reg.match } : {}),
      handler: null,
    })
  }
}

// ─── Actor Slot ─────────────────────────────────────────────────────────────
//
// Tracks a single config-managed child actor: its config, ref, and generation
// counter. Provides a uniform shape for plugin-managed child actors.
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

/**
 * Recursively merges `override` into `base`.
 * - If `override` specifies a key with `undefined`, the base value is kept.
 * - Explicit `null` values in `override` are preserved (not reverted to defaults).
 * - Arrays and primitives are replaced wholesale.
 */
export const deepMerge = (base: unknown, override: unknown): unknown => {
  if (override === undefined) return base
  if (
    override === null ||
    typeof override !== 'object' ||
    Array.isArray(override)
  ) {
    return override
  }
  if (
    base === null ||
    typeof base !== 'object' ||
    Array.isArray(base)
  ) {
    return override
  }
  const result: Record<string, unknown> = { ...(base as Record<string, unknown>) }
  for (const [key, val] of Object.entries(override as Record<string, unknown>)) {
    if (val !== undefined) {
      result[key] = deepMerge(result[key], val)
    }
  }
  return result
}
