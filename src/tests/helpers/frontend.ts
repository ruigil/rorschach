import { store, __resetStoreForTests } from '../../frontend/webkit/runtime/store.js'
import { __resetPluginHostForTests } from '../../frontend/shell/plugin-host.js'
import type { ShellState } from '../../frontend/shell/types.js'

const defaultState: Partial<ShellState> = {
  isConnected: false,
  isWaiting: false,
  currentUserId: null,
  currentUserRoles: [],
  agents: [],
  currentMode: '',
  currentModeDisplayName: '',
  messages: [],
  lastMessages: [],
  activeStream: {
    isActive: false,
    reasoning: '',
    text: '',
    sources: [],
    attachments: [],
    toolCalls: [],
  },
  views: {},
  activeWorkspaceTab: 'none',
  workspaceTabOrder: [],
}

export const resetStore = () => {
  __resetStoreForTests()
  __resetPluginHostForTests()
  store.namespace<ShellState>('shell').init(defaultState, {
    persist: ['currentMode', 'activeWorkspaceTab', 'lastMessages'],
  })
  store.namespace('observe').init({
    actors: [],
    topics: [],
    logs: [],
    traces: [],
    usage: [],
    tools: {},
    agents: [],
  })
}

export const mockStore = (key: keyof ShellState, value: any) => {
  store.namespace<ShellState>('shell').set(key, value)
}

const registry: Record<string, any> = {}

export const register = (tag: string, cls: any) => {
  if (!registry[tag]) {
    registry[tag] = cls
    if (!customElements.get(tag)) {
      customElements.define(tag, cls)
    }
  }
}

export const mount = async (tag: string, attrs?: Record<string, string>) => {
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

export const mountClass = async (cls: any, attrs?: Record<string, string>) => {
  const el = new cls()
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      el.setAttribute(k, v)
      el[k] = v
    }
  }
  document.body.appendChild(el)
  if (typeof el.updateComplete !== 'undefined') {
    await el.updateComplete
  }
  return el
}

export const nextFrame = async () => {
  return new Promise(r => requestAnimationFrame(r))
}

export const cleanup = () => {
  document.body.innerHTML = ''
  resetStore()
}
