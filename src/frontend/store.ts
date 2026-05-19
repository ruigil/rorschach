import { type RorschachState } from './types/state.js'

const state: RorschachState = {
  isConnected: false,
  isWaiting: false,
  currentUserId: null,
  currentUserRoles: [],
  agents: [],
  currentMode: '',
  currentModeDisplayName: '',
  topics: [],
  actors: [],
  logs: [],
  ws: null,
}

type StateKey = keyof RorschachState
type Listener<T extends StateKey> = (value: RorschachState[T], prev: RorschachState[T]) => void

const listeners = new Map<StateKey, Set<Listener<any>>>()

function notify<T extends StateKey>(key: T, value: RorschachState[T], prev: RorschachState[T]) {
  const set = listeners.get(key)
  if (set) {
    for (const cb of set) {
      try { cb(value, prev) } catch (e) {
        console.error('Store listener error:', e)
      }
    }
  }
}

export const store = {
  get<T extends StateKey>(key: T): RorschachState[T] {
    return state[key]
  },

  set<T extends StateKey>(key: T, value: RorschachState[T]) {
    const prev = state[key]
    state[key] = value
    if (prev !== value) notify(key, value, prev)
  },

  subscribe<T extends StateKey>(key: T, callback: Listener<T>) {
    if (!listeners.has(key)) listeners.set(key, new Set())
    listeners.get(key)!.add(callback)
    callback(state[key], state[key])
    return () => {
      const set = listeners.get(key)
      if (set) {
        set.delete(callback)
        if (set.size === 0) listeners.delete(key)
      }
    }
  },

  getState() {
    return state
  },
}
