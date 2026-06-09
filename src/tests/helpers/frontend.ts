import { store } from '../../frontend/store.js'
import { DEFAULT_TAB, DEFAULT_OBSERVE_TAB } from '../../frontend/constants.js'

const defaultState: Record<string, any> = {
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
  activeTab: DEFAULT_TAB,
  observeActiveTab: DEFAULT_OBSERVE_TAB,
  activeStream: {
    isActive: false,
    reasoning: '',
    text: '',
    sources: [],
    attachments: [],
  },
  currentWorkflowGraph: null,
  workflowWorkspaceOpen: false,
}

export function resetStore() {
  for (const [key, value] of Object.entries(defaultState)) {
    store.set(key as any, typeof value === 'object' && value !== null
      ? (Array.isArray(value) ? [...value] : { ...value })
      : value)
  }
}

export function mockStore(key: string, value: any) {
  store.set(key as any, value)
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
