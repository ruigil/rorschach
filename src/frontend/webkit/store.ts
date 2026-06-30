// ─── Generic namespaced store ───
//
// The kit store is generic: no shell types, no plugin types. The root holds
// only `namespaces: Record<string, Record<string, unknown>>`. Every consumer
// — shell included — goes through `store.namespace(id)`, which returns a
// typed view scoped to `state.namespaces[id]`. Listeners are per-(namespace,
// key), so `subscribe('messages', cb)` on namespace `'shell'` does not fire
// for a key named `'messages'` on namespace `'workflows'`.

import type { ViewConfig, ViewRuntimeState } from './host-types.js'
import { readSavedViewState } from './view-state.js'

export type PersistOptions<T> = {
  /** Keys whose values should be automatically read from / written to
   *  localStorage under `rorschach.store.<namespace>.<key>`. The stored
   *  value is JSON-serialised and takes precedence over the default passed
   *  to `init` when a saved entry exists. */
  persist: (keyof T)[]
}

export type Namespace<T extends object> = {
  get<K extends keyof T>(key: K): T[K]
  set<K extends keyof T>(key: K, value: T[K]): void
  subscribe<K extends keyof T>(key: K, cb: (val: T[K], prev: T[K]) => void): () => void
  /** Seed defaults into namespaces[id] if absent. No-op if already seeded.
   *  Pass `{ persist: ['key'] }` to make those keys survive page refreshes
   *  via localStorage automatically. */
  init(values?: Partial<T>, opts?: PersistOptions<T>): void
  /** Delete namespaces[id] entirely — frees memory, drops the source that
   *  listeners read from. Called on plugin unregister. */
  reset(): void
};

export type Store = {
  /** Returns the typed view for `id`, lazily creating namespaces[id] = {} on
   *  first access. Shell and plugins use the same API. */
  namespace<T extends object>(id: string): Namespace<T>
  /** Seed namespaces['shell']['views'][id] from cfg defaults merged with
   *  saved localStorage state (rorschach.view_state.<id>). Idempotent. */
  ensureView(id: string, cfg: ViewConfig): void
  /** Set namespaces['shell']['views'][id].isOpen = false. Convenience over
   *  namespace('shell').get('views')[id].isOpen = false. */
  closeView(id: string): void
};

// ─── Internal implementation ───

type StoreRoot = {
  namespaces: Record<string, Record<string, unknown>>
};

const root: StoreRoot = { namespaces: {} }

// Keys that have opted into localStorage persistence, keyed by namespace id.
const persistedKeys: Record<string, Set<string>> = {}

const storageKey = (nsId: string, key: string) => `rorschach.store.${nsId}.${key}`

const readPersisted = (nsId: string, key: string): { found: true; value: unknown } | { found: false } => {
  if (typeof localStorage === 'undefined') return { found: false }
  const raw = localStorage.getItem(storageKey(nsId, key))
  if (raw === null) return { found: false }
  try { return { found: true, value: JSON.parse(raw) } } catch { return { found: false } }
}

const writePersisted = (nsId: string, key: string, value: unknown): void => {
  if (typeof localStorage === 'undefined') return
  localStorage.setItem(storageKey(nsId, key), JSON.stringify(value))
}

// Listeners keyed by `${namespaceId}:${String(key)}`.
type Listener = (val: any, prev: any) => void
const listeners = new Map<string, Set<Listener>>()

const listenerKey = (nsId: string, key: string) => `${nsId}:${key}`

const notify = (nsId: string, key: string, value: any, prev: any): void => {
  const set = listeners.get(listenerKey(nsId, key))
  if (set) {
    for (const cb of set) {
      try { cb(value, prev) } catch (e) {
        console.error('Store listener error:', e)
      }
    }
  }
}

const makeNamespace = <T extends object>(nsId: string): Namespace<T> => {
  const ensure = () => {
    let ns = root.namespaces[nsId]
    if (!ns) {
      ns = {}
      root.namespaces[nsId] = ns
    }
    return ns
  }
  return {
    get<K extends keyof T>(key: K): T[K] {
      return (ensure() as T)[key]
    },
    set<K extends keyof T>(key: K, value: T[K]): void {
      const ns = ensure()
      const prev = (ns as T)[key]
      ;(ns as T)[key] = value
      if (persistedKeys[nsId]?.has(String(key))) writePersisted(nsId, String(key), value)
      if (prev !== value) notify(nsId, String(key), value, prev)
    },
    subscribe<K extends keyof T>(key: K, cb: (val: T[K], prev: T[K]) => void): () => void {
      const lk = listenerKey(nsId, String(key))
      let set = listeners.get(lk)
      if (!set) {
        set = new Set()
        listeners.set(lk, set)
      }
      set.add(cb as Listener)
      // Call immediately with current value (preserves the existing contract:
      // router.ts and StoreController rely on the initial fire).
      const ns = ensure()
      cb((ns as T)[key], (ns as T)[key])
      return () => {
        const s = listeners.get(lk)
        if (s) {
          s.delete(cb as Listener)
          if (s.size === 0) listeners.delete(lk)
        }
      }
    },
    init(values?: Partial<T>, opts?: PersistOptions<T>): void {
      const ns = ensure()
      // Register persistent keys first so that the set() path below can
      // write to localStorage even on the initial seed.
      if (opts?.persist) {
        if (!persistedKeys[nsId]) persistedKeys[nsId] = new Set()
        for (const k of opts.persist) persistedKeys[nsId].add(String(k))
      }
      // Only seed keys that are absent — don't overwrite a value that's
      // already been set (e.g. by a previous init or by a frame that arrived
      // before the module finished loading). Notify subscribers for each key
      // we seed: a subscriber that attached before init (e.g. a Lit controller
      // wired up during a custom-element upgrade that runs as a side-effect of
      // import) was initially fired with `undefined` and otherwise would never
      // learn that the value changed from `undefined` to the seeded default.
      // For persistent keys, a saved localStorage value takes precedence over
      // the supplied default.
      if (values) {
        for (const [k, v] of Object.entries(values)) {
          if (ns[k] === undefined) {
            const persisted = persistedKeys[nsId]?.has(k) ? readPersisted(nsId, k) : { found: false as const }
            ns[k] = persisted.found ? persisted.value : v
            notify(nsId, k, ns[k], undefined)
          }
        }
      }
    },
    reset(): void {
      delete root.namespaces[nsId]
      delete persistedKeys[nsId]
      // Drop all listeners for this namespace.
      const prefix = `${nsId}:`
      for (const lk of listeners.keys()) {
        if (lk.startsWith(prefix)) listeners.delete(lk)
      }
    },
  }
}

// ─── View runtime state helpers ───
//
// `readSavedViewState` is imported from `./view-state.js` so both halves
// of the view-state persistence contract share one source file. The writer
// lives in `view-actions.ts` (calls `localStorage.setItem` directly because
// the store's generic `persist` option is per-(namespace,key), not per-view).

const ensureViewRuntime = (id: string, cfg: ViewConfig): ViewRuntimeState => {
  const shell = root.namespaces['shell'] ?? {}
  const views = (shell['views'] ?? {}) as Record<string, ViewRuntimeState>
  if (views[id]) return views[id]!

  const state = readSavedViewState(id, cfg)
  shell['views'] = { ...views, [id]: state }
  root.namespaces['shell'] = shell
  notify('shell', 'views', shell['views'], shell['views'])
  return state
}

export const store: Store = {
  namespace<T extends object>(id: string): Namespace<T> {
    // Lazily create the namespace sub-object on first access.
    if (!root.namespaces[id]) root.namespaces[id] = {}
    return makeNamespace<T>(id)
  },

  ensureView(id: string, cfg: ViewConfig): void {
    ensureViewRuntime(id, cfg)
  },

  closeView(id: string): void {
    const shell = root.namespaces['shell']
    if (!shell) return
    const views = (shell['views'] ?? {}) as Record<string, ViewRuntimeState>
    const view = views[id]
    if (!view) return
    views[id] = { ...view, isOpen: false }
    notify('shell', 'views', shell['views'], shell['views'])
  },
}

// ─── Test helper: reset the store between tests ───
//
// The shell's test harness (`src/tests/helpers/frontend.ts`) calls this to
// restore a clean state. Production code never calls it.
export const __resetStoreForTests = (): void => {
  root.namespaces = {}
  listeners.clear()
  for (const k of Object.keys(persistedKeys)) delete persistedKeys[k]
}
