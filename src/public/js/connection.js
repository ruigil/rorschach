import { store } from './store.js'

const logoutBtn = document.getElementById('logout-btn')

logoutBtn?.addEventListener('click', async () => {
  await fetch(new URL('auth/logout', location.href), { method: 'POST' })
  window.location.href = new URL('auth/login.html', location.href).href
})

const wsMessageFrameTypes = new Set([
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

const targetFrameHandlers = {
  planGraph:         dispatchTo('r-plan-workspace', 'plan-graph'),
  usage:             callObserve('handleUsage'),
  log:               callObserve('handleLog'),
  metrics:           callObserve('handleMetrics'),
  trace:             callObserve('handleTrace'),
  tool_registered:   callObserve('handleToolRegistered'),
  tool_unregistered: callObserve('handleToolUnregistered'),
}

function dispatchTo(selector, eventName) {
  return (msg) => {
    document.querySelector(selector)?.dispatchEvent(new CustomEvent(eventName, { detail: msg, bubbles: true }))
  }
}

function callObserve(methodName) {
  return (msg) => {
    document.querySelector('r-observe-panel')?.[methodName]?.(msg)
  }
}

function dispatchFrame(msg) {
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
    // 503 or other → connect without ticket (auth not configured)
  } catch { /* network error — attempt connection anyway */ }

  const ws = new WebSocket(wsUrl.href)
  store.set('ws', ws)

  ws.addEventListener('open', () => {
    store.set('isConnected', true)
    const chatTab = document.querySelector('[data-tab="chat"].active')
    if (chatTab) document.getElementById('input')?.focus()
  })

  ws.addEventListener('close', () => {
    store.set('isConnected', false)
    store.set('isWaiting', false)
    setTimeout(connect, 2000)
  })

  ws.addEventListener('error', () => ws.close())

  ws.addEventListener('message', (e) => {
    let msg
    try { msg = JSON.parse(e.data) } catch { return }

    dispatchFrame(msg)
  })
}
