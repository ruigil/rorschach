import { type RorschachState } from './types/state.js'
import { type ReactiveController, type ReactiveControllerHost } from 'lit'
import { modeLabel } from './core/utils.js'

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
  traces: [],
  usage: [],
  tools: {},
  ws: null,
  messages: [],
  activeTab: 'chat',
  activeStream: {
    isActive: false,
    reasoning: '',
    text: '',
    sources: [],
    attachments: [],
  },
  currentPlanGraph: null,
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

  setMode(mode: string, displayName?: string) {
    this.set('currentMode', mode)
    this.set('currentModeDisplayName', displayName || modeLabel(mode))
  },

  addLog(log: any) {
    this.set('logs', [log, ...state.logs].slice(0, 500))
  },

  appendMessage(msg: any) {
    this.set('messages', [...state.messages, msg])
  },

  updateActiveStream(patch: Partial<RorschachState['activeStream']>) {
    this.set('activeStream', { ...state.activeStream, ...patch })
  },

  commitActiveStream(role: 'assistant' | 'error' = 'assistant', text?: string) {
    const active = state.activeStream
    const message = {
      id: crypto.randomUUID(),
      role,
      text: text ?? active.text,
      reasoning: active.reasoning,
      sources: [...active.sources],
      attachments: [...active.attachments],
      timestamp: Date.now(),
    }
    this.appendMessage(message)
    this.set('activeStream', {
      isActive: false,
      reasoning: '',
      text: '',
      sources: [],
      attachments: [],
    })
    this.set('isWaiting', false)
  },
}

export class StoreController<T extends StateKey> implements ReactiveController {
  private _unsub?: () => void
  public value: RorschachState[T]

  constructor(private host: ReactiveControllerHost, private key: T) {
    this.host.addController(this)
    this.value = store.get(this.key)
  }

  hostConnected() {
    this._unsub = store.subscribe(this.key, (val) => {
      this.value = val
      this.host.requestUpdate()
    })
  }

  hostDisconnected() {
    this._unsub?.()
  }
}
