import { state } from '../state.js'

const listeners = new Map()

export const store = {
  get(key) {
    return state[key]
  },

  set(key, value) {
    const prev = state[key]
    state[key] = value
    if (prev !== value) notify(key, value, prev)
  },

  subscribe(key, callback) {
    if (!listeners.has(key)) listeners.set(key, new Set())
    listeners.get(key).add(callback)
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

function notify(key, value, prev) {
  const set = listeners.get(key)
  if (set) {
    for (const cb of set) {
      try { cb(value, prev) } catch {}
    }
  }
}
