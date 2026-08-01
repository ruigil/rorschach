import type { PluginEntry } from './types.ts'

// ─── Env var interpolation (apply-time only; store keeps raw placeholders) ───
//
// Supports ${VAR} and ${VAR:-default} in string values.
// A whole-string expression is type-coerced: "3000" → 3000, "true" → true.
// Partial expressions like "prefix-${VAR}" remain strings.

export const interpolate = (value: unknown): unknown => {
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

export const normalizePluginEntry = (p: any): PluginEntry => {
  if (p && typeof p === 'object' && 'id' in p && 'handler' in p) return { def: p as any }
  return p as PluginEntry
}
