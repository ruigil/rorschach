import { type RorschachState, type WindowRuntimeState } from './types/state.js'
import { type ReactiveController, type ReactiveControllerHost } from 'lit'
import { DEFAULT_TAB, DEFAULT_OBSERVE_TAB } from './constants.js'
import { WINDOW_REGISTRY } from './core/window-registry.js'

const savedMessagesStr = typeof localStorage !== 'undefined' ? localStorage.getItem('rorschach.lastMessages') : null;
let savedMessages = [];
if (savedMessagesStr) {
  try { savedMessages = JSON.parse(savedMessagesStr); } catch {}
}

const savedMode = typeof localStorage !== 'undefined' ? localStorage.getItem('rorschach.currentMode') || '' : '';
const savedPlanOpen = typeof localStorage !== 'undefined' ? localStorage.getItem('rorschach.planWorkspaceOpen') === 'true' : false;

const savedUndockedStr = typeof localStorage !== 'undefined' ? localStorage.getItem('rorschach.chat_window_state') : null;
let savedIsUndocked = false;
if (savedUndockedStr) {
  try {
    savedIsUndocked = !!JSON.parse(savedUndockedStr).isUndocked;
  } catch {}
}

function getSavedWindowState(id: string): WindowRuntimeState {
  const config = WINDOW_REGISTRY[id];
  const defaultX = typeof window !== 'undefined' ? window.innerWidth - 420 : 800;
  const defaultY = 100;

  const defaultState: WindowRuntimeState = {
    id,
    isOpen: id === 'chat',
    isDocked: true,
    isMinimized: false,
    x: defaultX,
    y: defaultY,
    w: config?.defaultWidth ?? 400,
    h: config?.defaultHeight ?? 600,
    zIndex: 1000,
    params: {}
  };

  if (typeof localStorage === 'undefined') return defaultState;

  const saved = localStorage.getItem(`rorschach.window_state.${id}`);
  if (saved) {
    try {
      const parsed = JSON.parse(saved);
      return { ...defaultState, ...parsed };
    } catch {}
  }

  // Fallbacks
  if (id === 'chat') {
    const oldChat = localStorage.getItem('rorschach.chat_window_state');
    if (oldChat) {
      try {
        const parsed = JSON.parse(oldChat);
        return {
          ...defaultState,
          isDocked: !parsed.isUndocked,
          isMinimized: !!parsed.isCollapsed,
          x: typeof parsed.x === 'number' ? parsed.x : defaultX,
          y: typeof parsed.y === 'number' ? parsed.y : defaultY,
          w: typeof parsed.w === 'number' ? parsed.w : defaultState.w,
          h: typeof parsed.h === 'number' ? parsed.h : defaultState.h
        };
      } catch {}
    }
  }

  if (id === 'docs') {
    const docOpen = localStorage.getItem('rorschach.docWorkspaceOpen') === 'true';
    const docArtifact = localStorage.getItem('rorschach.docWorkspaceArtifact');
    if (docOpen || docArtifact) {
      return {
        ...defaultState,
        isOpen: docOpen,
        params: docArtifact ? { currentDocArtifact: docArtifact } : {}
      };
    }
  }

  if (id === 'plans') {
    const planOpen = localStorage.getItem('rorschach.planWorkspaceOpen') === 'true';
    if (planOpen) {
      return {
        ...defaultState,
        isOpen: planOpen
      };
    }
  }

  return defaultState;
}

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
  activeTab: DEFAULT_TAB,
  observeActiveTab: DEFAULT_OBSERVE_TAB,
  activeStream: {
    isActive: false,
    reasoning: '',
    text: '',
    sources: [],
    attachments: [],
  },
  currentPlanGraph: null,
  planWorkspaceOpen: savedPlanOpen,
  docWorkspaceOpen: false,
  currentDocArtifact: null,
  isChatUndocked: savedIsUndocked,
  windows: {
    chat: getSavedWindowState('chat'),
    docs: getSavedWindowState('docs'),
    plans: getSavedWindowState('plans'),
  },
  activeWindowIds: ['chat'],
  activeWorkspaceTab: localStorage.getItem('rorschach.activeWorkspaceTab') || 'docs',
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
