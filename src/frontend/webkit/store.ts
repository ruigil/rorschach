// ─── Generic namespaced store ───
//
// The kit store is generic: no shell types, no plugin types. The root holds
// only `namespaces: Record<string, Record<string, unknown>>`. Every consumer
// — shell included — goes through `store.namespace(id)`, which returns a
// typed view scoped to `state.namespaces[id]`. Listeners are per-(namespace,
// key), so `subscribe('messages', cb)` on namespace `'shell'` does not fire
// for a key named `'messages'` on namespace `'workflows'`.

import type { WindowConfig, WindowRuntimeState } from './host-types.js'

export type Namespace<T extends object> = {
  get<K extends keyof T>(key: K): T[K]
  set<K extends keyof T>(key: K, value: T[K]): void
  subscribe<K extends keyof T>(key: K, cb: (val: T[K], prev: T[K]) => void): () => void
  /** Seed defaults into namespaces[id] if absent. No-op if already seeded.
   *  A plugin calls this at module load to declare its initial state shape. */
  init(values?: Partial<T>): void
  /** Delete namespaces[id] entirely — frees memory, drops the source that
   *  listeners read from. Called on plugin unregister. */
  reset(): void
};

export type Store = {
  /** Returns the typed view for `id`, lazily creating namespaces[id] = {} on
   *  first access. Shell and plugins use the same API. */
  namespace<T extends object>(id: string): Namespace<T>
  /** Seed namespaces['shell']['windows'][id] from cfg defaults merged with
   *  saved localStorage state (rorschach.window_state.<id>). Generalizes
   *  today's getSavedWindowState. Idempotent. */
  ensureWindow(id: string, cfg: WindowConfig): void
  /** Set namespaces['shell']['windows'][id].isOpen = false. Convenience over
   *  namespace('shell').get('windows')[id].isOpen = false. */
  closeWindow(id: string): void
};

// ─── Internal implementation ───

type StoreRoot = {
  namespaces: Record<string, Record<string, unknown>>
};

const root: StoreRoot = { namespaces: {} }

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
    init(values?: Partial<T>): void {
      const ns = ensure()
      // Only seed keys that are absent — don't overwrite a value that's
      // already been set (e.g. by a previous init or by a frame that arrived
      // before the module finished loading). Notify subscribers for each key
      // we seed: a subscriber that attached before init (e.g. a Lit controller
      // wired up during a custom-element upgrade that runs as a side-effect of
      // import) was initially fired with `undefined` and otherwise would never
      // learn that the value changed from `undefined` to the seeded default.
      if (values) {
        for (const [k, v] of Object.entries(values)) {
          if (ns[k] === undefined) {
            ns[k] = v
            notify(nsId, k, v, undefined)
          }
        }
      }
    },
    reset(): void {
      delete root.namespaces[nsId]
      // Drop all listeners for this namespace.
      const prefix = `${nsId}:`
      for (const lk of listeners.keys()) {
        if (lk.startsWith(prefix)) listeners.delete(lk)
      }
    },
  }
}

// ─── Window runtime state helpers ───

const readSavedWindowState = (id: string, cfg: WindowConfig): WindowRuntimeState => {
  const defaultX = typeof window !== 'undefined' ? window.innerWidth - 420 : 800
  const defaultY = 100

  const defaultState: WindowRuntimeState = {
    id,
    isOpen: id === 'chat',
    isDocked: true,
    isMinimized: false,
    x: defaultX,
    y: defaultY,
    w: cfg.defaultWidth,
    h: cfg.defaultHeight,
    zIndex: 1000,
    params: {},
  }

  if (typeof localStorage === 'undefined') return defaultState

  const saved = localStorage.getItem(`rorschach.window_state.${id}`)
  if (saved) {
    try {
      const parsed = JSON.parse(saved)
      return { ...defaultState, ...parsed }
    } catch { /* fall through */ }
  }

  return defaultState
}

const ensureWindowRuntime = (id: string, cfg: WindowConfig): WindowRuntimeState => {
  const shell = root.namespaces['shell'] ?? {}
  const windows = (shell['windows'] ?? {}) as Record<string, WindowRuntimeState>
  if (windows[id]) return windows[id]!

  const state = readSavedWindowState(id, cfg)
  shell['windows'] = { ...windows, [id]: state }
  root.namespaces['shell'] = shell
  notify('shell', 'windows', shell['windows'], shell['windows'])
  return state
}

export const store: Store = {
  namespace<T extends object>(id: string): Namespace<T> {
    // Lazily create the namespace sub-object on first access.
    if (!root.namespaces[id]) root.namespaces[id] = {}
    return makeNamespace<T>(id)
  },

  ensureWindow(id: string, cfg: WindowConfig): void {
    ensureWindowRuntime(id, cfg)
  },

  closeWindow(id: string): void {
    const shell = root.namespaces['shell']
    if (!shell) return
    const windows = (shell['windows'] ?? {}) as Record<string, WindowRuntimeState>
    const win = windows[id]
    if (!win) return
    windows[id] = { ...win, isOpen: false }
    notify('shell', 'windows', shell['windows'], shell['windows'])
  },
}

// ─── Test helper: reset the store between tests ───
//
// The shell's test harness (`src/tests/helpers/frontend.ts`) calls this to
// restore a clean state. Production code never calls it.
export const __resetStoreForTests = (): void => {
  root.namespaces = {}
  listeners.clear()
}
