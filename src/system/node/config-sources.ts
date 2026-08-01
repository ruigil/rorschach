import { watch as fsWatch } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { deepMerge } from '../actor/config.ts'
import type { PluginDef } from '../actor/types.ts'
import {
  type ConfigSource,
  type DesiredState,
  type DesiredStatePatch,
  type PluginEntry,
} from './types.ts'
import { normalizePluginEntry, interpolate } from './utils.ts'

// ─── Process-wide write queues (from file-source) ───────────────────────────
// Process-wide write queues keyed by resolved path so multiple FileSource
// instances on the same file can serialize safely.
const writeQueues = new Map<string, Promise<unknown>>()

const enqueue = <T>(path: string, work: () => Promise<T>): Promise<T> => {
  const prev = writeQueues.get(path) ?? Promise.resolve()
  const next = prev.then(work, work)
  writeQueues.set(
    path,
    next.then(
      () => undefined,
      () => undefined,
    ),
  )
  return next
}

// ─── Desired Patch & Revision Algebra (from desired-patch) ──────────────────

/** Apply a DesiredStatePatch onto current desired state. */
export const applyDesiredPatch = (
  curr: DesiredState,
  update: DesiredStatePatch,
): DesiredState => {
  let plugins = curr.plugins
  if (update.plugins !== undefined) {
    plugins = update.plugins.map(normalizePluginEntry)
  }
  const config =
    update.config !== undefined
      ? (deepMerge(curr.config, update.config) as Record<string, unknown>)
      : curr.config
  return { plugins, config }
}

/**
 * Content-hash revision of a desired document.
 * Stable JSON stringify of normalized plugins + config.
 */
export const revisionOf = (state: DesiredState): string => {
  const plugins = state.plugins.map((p) => {
    if (p.def) return `def:${p.def.id}@${p.def.version}:${p.modulePath ?? ''}`
    return `${p.modulePath ?? ''}#${p.reloadNonce ?? ''}`
  })
  const canonical = JSON.stringify({ plugins, config: state.config })
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16)
}

/**
 * Content-hash of the desired config subtree only (stable JSON).
 * Used by node-control for configChanged so plugin-only desired edits do not
 * emit ApplyConfig / notify every plugin via onConfigChange.
 * Document revision (revisionOf) still tracks full desired lag for observed.
 */
export const configRevisionOf = (config: Record<string, unknown>): string => {
  const canonical = JSON.stringify(config)
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16)
}

// ─── StaticSource (from static-source) ──────────────────────────────────────

type StaticSourceInput = {
  plugins?: (PluginEntry | PluginDef<any, any, any>)[]
  config?: Record<string, unknown>
}

/**
 * In-memory ConfigSource for tests and examples.
 */
export const staticSource = (
  initial: StaticSourceInput = {},
): ConfigSource => {
  const normalized: PluginEntry[] = (initial.plugins ?? []).map(normalizePluginEntry)

  let state: DesiredState = {
    plugins: normalized,
    config: initial.config ?? {},
  }
  const listeners = new Set<() => void>()
  const rev = () => revisionOf(state)

  const read = async (): Promise<{ state: DesiredState; revision: string }> => ({
    state: {
      plugins: [...state.plugins],
      config: structuredClone(state.config),
    },
    revision: rev(),
  })

  const write = async (
    patch: (curr: DesiredState) => DesiredStatePatch | Promise<DesiredStatePatch>,
  ): Promise<{ revision: string }> => {
    const update = await patch({
      plugins: [...state.plugins],
      config: structuredClone(state.config),
    })
    state = applyDesiredPatch(state, update)
    for (const cb of listeners) cb()
    return { revision: rev() }
  }

  const watch = (onChange: () => void): (() => void) => {
    listeners.add(onChange)
    return () => {
      listeners.delete(onChange)
    }
  }

  return {
    read,
    write,
    watch,
  }
}

// ─── FileSource (from file-source) ──────────────────────────────────────────

const readFileState = async (configPath: string): Promise<DesiredState> => {
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

  const plugins = obj.plugins
  const config =
    obj.config !== null && typeof obj.config === 'object' && !Array.isArray(obj.config)
      ? (obj.config as Record<string, unknown>)
      : {}

  const normalized: PluginEntry[] = Array.isArray(plugins)
    ? plugins.map(normalizePluginEntry)
    : []

  return {
    plugins: normalized,
    config,
  }
}

const WATCH_COALESCE_MS = 75

/**
 * Resolve config.json path: --config CLI → CONFIG_PATH env → default.
 * This is the **sole operator-facing path knob**. The field
 * `config.config.configPath` in the desired document is a mirror for the admin
 * plugin FileSource — not a second control knob (see ensureAdminConfigPath).
 */
export const resolveConfigPath = (override?: string): string => {
  const argIdx = process.argv.indexOf('--config')
  const resolved = resolve(
    override ??
      (argIdx !== -1 ? process.argv[argIdx + 1] : undefined) ??
      process.env.CONFIG_PATH ??
      'config.json',
  )
  process.env.CONFIG_DIR = dirname(resolved)
  return resolved
}

/**
 * ConfigSource backed by a config.json file.
 * revision = content hash of the desired document.
 * write() deep-merges config patches into the on-disk document.
 * watch() uses fs.watch with burst coalescing (hint only; resync is the guarantee).
 */
export const fileSource = (configPath: string): ConfigSource => {
  const path = resolve(configPath)
  process.env.CONFIG_DIR = dirname(path)

  const read = async (): Promise<{ state: DesiredState; revision: string }> => {
    const state = await readFileState(path)
    const interpolated = {
      ...state,
      plugins: interpolate(state.plugins) as PluginEntry[],
    }
    return { state: interpolated, revision: revisionOf(interpolated) }
  }

  const write = (
    patch: (curr: DesiredState) => DesiredStatePatch | Promise<DesiredStatePatch>,
  ): Promise<{ revision: string }> =>
    enqueue(path, async () => {
      const current = await readFileState(path)
      const update = await patch(current)
      const nextState = applyDesiredPatch(current, update)

      // Preserve unknown top-level keys from the existing file when present.
      let previous: Record<string, unknown> = {}
      try {
        const raw = await Bun.file(path).text()
        previous = (JSON.parse(raw) ?? {}) as Record<string, unknown>
      } catch {
        previous = {}
      }

      const nextObj = {
        ...previous,
        plugins: nextState.plugins,
        config: nextState.config,
      }

      await Bun.write(path, JSON.stringify(nextObj, null, 2) + '\n')
      return { revision: revisionOf(nextState) }
    })

  const watch = (onChange: () => void): (() => void) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let closed = false

    const fire = () => {
      if (closed) return
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = undefined
        if (!closed) onChange()
      }, WATCH_COALESCE_MS)
    }

    let watcher: ReturnType<typeof fsWatch> | undefined
    try {
      watcher = fsWatch(path, { persistent: false }, fire)
      watcher.on('error', (err) => {
        // Hint only — log and keep resync as the guarantee.
        console.warn(`[file-source] watch error on ${path}:`, err)
      })
    } catch (err) {
      console.warn(`[file-source] failed to watch ${path}:`, err)
    }

    return () => {
      closed = true
      if (timer) clearTimeout(timer)
      watcher?.close()
    }
  }

  return { read, write, watch }
}
