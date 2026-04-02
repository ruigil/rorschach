import { resolve, dirname } from 'node:path'
import type { PluginDef } from './system/types.ts'

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
): Promise<{ plugins: PluginDef<any, any, any>[]; config: Record<string, unknown>; configPath: string }> => {
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
  const plugins: PluginDef<any, any, any>[] = []

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
    plugins.push(def as PluginDef<any, any, any>)
  }

  const config = interpolate(obj.config ?? {}) as Record<string, unknown>

  return { plugins, config, configPath: path }
}

// ─── saveConfig ───────────────────────────────────────────────────────────────
//
// Deep-merges `patch` into the on-disk config file at `configPath`, preserving
// env-var references (e.g. ${MY_KEY}) for any key not touched by the patch.
// Only plain-object nodes are merged; arrays and primitives are replaced.
//
const deepMergeRaw = (base: unknown, override: unknown): unknown => {
  if (override === undefined) return base
  if (
    override === null ||
    typeof override !== 'object' ||
    Array.isArray(override)
  ) return override ?? base
  if (base === null || typeof base !== 'object' || Array.isArray(base)) return override
  const result: Record<string, unknown> = { ...(base as Record<string, unknown>) }
  for (const [key, val] of Object.entries(override as Record<string, unknown>)) {
    if (val !== undefined) result[key] = deepMergeRaw(result[key], val)
  }
  return result
}

export const saveConfig = async (
  configPath: string,
  patch: Record<string, unknown>,
): Promise<void> => {
  const raw = await Bun.file(configPath).text()
  const obj = JSON.parse(raw) as Record<string, unknown>
  const merged = deepMergeRaw(obj.config ?? {}, patch)
  await Bun.write(configPath, JSON.stringify({ ...obj, config: merged }, null, 2) + '\n')
}
