import { store, __resetStoreForTests } from '../../frontend/webkit/store.js'
import { DEFAULT_OBSERVE_TAB } from '../../frontend/constants.js'
import type { ShellState } from '../../frontend/types/state.js'

const defaultState: Partial<ShellState> = {
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
  messages: [],
  lastMessages: [],
  observeActiveTab: DEFAULT_OBSERVE_TAB,
  activeStream: {
    isActive: false,
    reasoning: '',
    text: '',
    sources: [],
    attachments: [],
  },
  views: {},
  activeWorkspaceTab: 'docs',
}

export function resetStore() {
  __resetStoreForTests()
  store.namespace<ShellState>('shell').init(defaultState, {
    persist: ['currentMode', 'activeWorkspaceTab', 'lastMessages'],
  })
}

export function mockStore(key: keyof ShellState, value: any) {
  store.namespace<ShellState>('shell').set(key, value)
}

const registry: Record<string, any> = {}

export function register(tag: string, cls: any) {
  if (!registry[tag]) {
    registry[tag] = cls
    if (!customElements.get(tag)) {
      customElements.define(tag, cls)
    }
  }
}

export async function mount(tag: string, attrs?: Record<string, string>) {
  const el = document.createElement(tag)
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      el.setAttribute(k, v)
    }
  }
  document.body.appendChild(el)
  if (typeof (el as any).updateComplete !== 'undefined') {
    await (el as any).updateComplete
  }
  return el
}

export async function mountClass(cls: any, attrs?: Record<string, string>) {
  const el = new cls()
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      el.setAttribute(k, v)
    }
  }
  document.body.appendChild(el)
  if (typeof el.updateComplete !== 'undefined') {
    await el.updateComplete
  }
  return el
}

export async function nextFrame() {
  return new Promise(r => requestAnimationFrame(r))
}

export function cleanup() {
  document.body.innerHTML = ''
  resetStore()
}
