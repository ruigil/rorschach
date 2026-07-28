import { resolve, dirname } from 'node:path'
import { deepMerge } from './system/index.ts'
import type { PluginDef } from './system/index.ts'

// ─── Env var interpolation ───────────────────────────────────────────────────
//
// Supports ${VAR} and ${VAR:-default} in string values.
// A whole-string expression is type-coerced: "3000" → 3000, "true" → true.
// Partial expressions like "prefix-${VAR}" remain strings.
//
const interpolate = (value: unknown): unknown => {
  if (typeof value === 'string') {
    const full = value.match(/^\$\{([^}:-]+)(?::-(.*?))?\}$/)
    if (full) {
      const resolved = process.env[full[1]!] ?? full[2] ?? ''
      if (resolved !== '' && !Number.isNaN(Number(resolved))) return Number(resolved)
      if (resolved === 'true') return true
      if (resolved === 'false') return false
      return resolved
    }
    return value.replace(/\$\{([^}:-]+)(?::-(.*?))?\}/g, (_, name, fb) => process.env[name] ?? fb ?? '')
  }
  if (Array.isArray(value)) return value.map(interpolate)
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, interpolate(v)]),
    )
  return value
}

// ─── loadConfig ──────────────────────────────────────────────────────────────
//
// Reads a config.json file, resolves plugin paths relative to the file's
// directory, dynamically imports each plugin, and interpolates env vars in the
// config tree. The result maps directly to PluginSystemOptions.
//
// Config file path resolution order:
//   1. --config <path> CLI argument
//   2. CONFIG_PATH environment variable
//   3. ./config.json (relative to cwd)
//
export const loadConfig = async (
  override?: string,
): Promise<{
  plugins: { def: PluginDef<any, any, any>; modulePath: string }[]
  config: Record<string, unknown>
  configPath: string
}> => {
  const argIdx = process.argv.indexOf('--config')
  const path = resolve(
    override ??
    (argIdx !== -1 ? process.argv[argIdx + 1] : undefined) ??
    process.env.CONFIG_PATH ??
    'config.json',
  )

  let raw: string
  try {
    raw = await Bun.file(path).text()
  } catch {
    throw new Error(`Cannot read config file: ${path}`)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    throw new Error(`Invalid JSON in config file: ${path}\n${e}`)
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('Config root must be a JSON object')

  const obj = parsed as Record<string, unknown>

  if (!Array.isArray(obj.plugins) || !obj.plugins.every((p): p is string => typeof p === 'string'))
    throw new Error('Config "plugins" must be an array of path strings')

  if (obj.config !== undefined && (typeof obj.config !== 'object' || Array.isArray(obj.config)))
    throw new Error('Config "config" must be a plain object')

  const configDir = dirname(path)
  const plugins: { def: PluginDef<any, any, any>; modulePath: string }[] = []

  for (const rel of obj.plugins as string[]) {
    const absPath = resolve(configDir, rel)
    let mod: unknown
    try {
      mod = await import(absPath)
    } catch (e) {
      throw new Error(`Failed to import plugin from: ${absPath}\n${e}`)
    }
    const def = (mod as Record<string, unknown>).default
    if (!def || typeof def !== 'object' || typeof (def as Record<string, unknown>).id !== 'string')
      throw new Error(`Plugin at ${absPath} must export a PluginDef with an "id" field as default`)
    plugins.push({ def: def as PluginDef<any, any, any>, modulePath: absPath })
  }

  const config = interpolate(obj.config ?? {}) as Record<string, unknown>

  return { plugins, config, configPath: path }
}

let configSaveQueue: Promise<void> = Promise.resolve()

export type FullConfigData = {
  plugins: string[]
  config: Record<string, unknown>
}

export const saveConfigUnified = (
  configPath: string,
  updater: (current: FullConfigData) => Partial<FullConfigData> | Promise<Partial<FullConfigData>>,
): Promise<void> => {
  const currentLink = configSaveQueue
  const next = currentLink.then(async () => {
    let raw = ''
    try {
      raw = await Bun.file(configPath).text()
    } catch {
      raw = '{}'
    }

    let obj: Record<string, unknown>
    try {
      obj = (JSON.parse(raw) ?? {}) as Record<string, unknown>
    } catch {
      obj = {}
    }

    const currentPlugins = Array.isArray(obj.plugins) ? (obj.plugins as string[]) : []
    const currentConfig =
      obj.config !== null && typeof obj.config === 'object' && !Array.isArray(obj.config)
        ? (obj.config as Record<string, unknown>)
        : {}

    const update = await updater({ plugins: currentPlugins, config: currentConfig })

    const nextPlugins = update.plugins !== undefined ? update.plugins : currentPlugins
    const nextConfig = update.config !== undefined ? deepMerge(currentConfig, update.config) : currentConfig

    const nextObj = {
      ...obj,
      plugins: nextPlugins,
      config: nextConfig,
    }

    await Bun.write(configPath, JSON.stringify(nextObj, null, 2) + '\n')
  })
  configSaveQueue = next.catch(() => {})
  return next
}



