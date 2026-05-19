import { store } from './store.js'
import { type WSFrame, type WSFrameType } from './types/websocket.js'

const logoutBtn = document.getElementById('logout-btn')

logoutBtn?.addEventListener('click', async () => {
  await fetch(new URL('auth/logout', location.href), { method: 'POST' })
  window.location.href = new URL('auth/login.html', location.href).href
})

const wsMessageFrameTypes = new Set<WSFrameType>([
  'chunk',
  'done',
  'error',
  'tooling',
  'sources',
  'attachments',
  'reasoningChunk',
  'plannerMode',
  'modeChanged',
  'agents',
])

const targetFrameHandlers: Partial<Record<WSFrameType, (msg: any) => void>> = {
  planGraph:         dispatchTo('r-plan-workspace', 'plan-graph'),
  usage:             callObserve('handleUsage'),
  log:               callObserve('handleLog'),
  metrics:           callObserve('handleMetrics'),
  trace:             callObserve('handleTrace'),
  tool_registered:   callObserve('handleToolRegistered'),
  tool_unregistered: callObserve('handleToolUnregistered'),
}

function dispatchTo(selector: string, eventName: string) {
  return (msg: any) => {
    document.querySelector(selector)?.dispatchEvent(new CustomEvent(eventName, { detail: msg, bubbles: true }))
  }
}

function callObserve(methodName: string) {
  return (msg: any) => {
    (document.querySelector('r-observe-panel') as any)?.[methodName]?.(msg)
  }
}

function dispatchFrame(msg: WSFrame) {
  if (wsMessageFrameTypes.has(msg.type)) {
    document.dispatchEvent(new CustomEvent('ws-message', { detail: msg, bubbles: true }))
    return
  }

  targetFrameHandlers[msg.type]?.(msg)
}

export async function connect() {
  const wsUrl = new URL('ws', location.href)
  wsUrl.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'

  try {
    const ticketRes = await fetch(new URL('auth/ticket', location.href), { method: 'POST' })
    if (ticketRes.status === 401) {
      window.location.href = new URL('auth/login.html', location.href).href
      return
    }
    if (ticketRes.ok) {
      const { ticket } = await ticketRes.json()
      wsUrl.searchParams.set('ticket', ticket)
    }
  } catch (e) {
    console.warn('Authentication ticket fetch failed, attempting connection anyway.', e)
  }

  const ws = new WebSocket(wsUrl.href)
  store.set('ws', ws)

  ws.addEventListener('open', () => {
    store.set('isConnected', true)
    const chatTab = document.querySelector('[data-tab="chat"].active')
    if (chatTab) {
      (document.getElementById('input') as HTMLElement | null)?.focus()
    }
  })

  ws.addEventListener('close', () => {
    store.set('isConnected', false)
    store.set('isWaiting', false)
    setTimeout(connect, 2000)
  })

  ws.addEventListener('error', () => ws.close())

  ws.addEventListener('message', (e) => {
    let msg: WSFrame
    try {
      msg = JSON.parse(e.data)
    } catch {
      return
    }

    dispatchFrame(msg)
  })
}
