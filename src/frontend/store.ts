import { type RorschachState } from './types/state.js'
import { type ReactiveController, type ReactiveControllerHost } from 'lit'

const savedMessagesStr = typeof localStorage !== 'undefined' ? localStorage.getItem('rorschach.lastMessages') : null;
let savedMessages = [];
if (savedMessagesStr) {
  try { savedMessages = JSON.parse(savedMessagesStr); } catch {}
}

const savedMode = typeof localStorage !== 'undefined' ? localStorage.getItem('rorschach.currentMode') || '' : '';
const savedPlanOpen = typeof localStorage !== 'undefined' ? localStorage.getItem('rorschach.planWorkspaceOpen') === 'true' : false;

const state: RorschachState = {
  isConnected: false,
  isWaiting: false,
  currentUserId: null,
  currentUserRoles: [],
  agents: [],
  currentMode: savedMode,
  currentModeDisplayName: '',
  topics: [],
  actors: [],
  logs: [],
  traces: [],
  usage: [],
  tools: {},
  ws: null,
  messages: savedMessages,
  activeTab: 'chat',
  observeActiveTab: 'metrics',
  activeStream: {
    isActive: false,
    reasoning: '',
    text: '',
    sources: [],
    attachments: [],
  },
  currentPlanGraph: null,
  planWorkspaceOpen: savedPlanOpen,
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
