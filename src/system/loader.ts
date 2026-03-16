import type { PluginDef, PluginSource } from '../plugins/types.ts'

export const loadPluginModule = async (source: PluginSource): Promise<PluginDef<unknown>> => {
  if (source.type === 'inline') return source.def as PluginDef<unknown>

  const mod = await import(source.value)
  const def = mod.default ?? mod

  if (typeof def?.id !== 'string')
    throw new Error(`Plugin must export a PluginDef with string 'id'`)
  if (typeof def?.version !== 'string')
    throw new Error(`Plugin must export a PluginDef with string 'version'`)
  if (typeof def?.activate !== 'function')
    throw new Error(`Plugin must export a PluginDef with 'activate' function`)

  return def as PluginDef<unknown>
}
