import { state } from './state.js'
import { setChatInputEnabled, setWaiting, removeThinking, resetStream, handleChatMsg } from './chat/messages.js'
import { onUsageMsg } from './observe/costs.js'
import { appendLog } from './observe/logs.js'
import { updateMetrics } from './observe/actors.js'
import { onTraceSpan } from './observe/traces.js'
import { onToolRegistered, onToolUnregistered } from './observe/tools.js'

const dot         = document.getElementById('dot')
const statusLabel = document.getElementById('status-label')
const logoutBtn   = document.getElementById('logout-btn')

logoutBtn.addEventListener('click', async () => {
  await fetch(new URL('auth/logout', location.href), { method: 'POST' })
  window.location.href = new URL('auth/login.html', location.href).href
})

function setConnected(connected) {
  state.isConnected = connected
  dot.className     = 'header-dot ' + (connected ? 'connected' : 'disconnected')
  statusLabel.textContent = connected ? 'connected' : 'reconnecting…'
  setChatInputEnabled(connected)
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
      logoutBtn.style.display = ''
    }
    // 503 or other → connect without ticket (auth not configured)
  } catch { /* network error — attempt connection anyway */ }

  state.ws = new WebSocket(wsUrl.href)

  state.ws.addEventListener('open', () => {
    setConnected(true)
    const chatTab = document.querySelector('[data-tab="chat"].active')
    if (chatTab) document.getElementById('input')?.focus()
  })

  state.ws.addEventListener('close', () => {
    setConnected(false)
    removeThinking()
    resetStream()
    setWaiting(false)
    setTimeout(connect, 2000)
  })

  state.ws.addEventListener('error', () => state.ws.close())

  state.ws.addEventListener('message', (e) => {
    let msg
    try { msg = JSON.parse(e.data) } catch { return }

    const chatTypes = ['chunk', 'done', 'error', 'searching', 'sources', 'reasoningChunk', 'plannerMode']
    if      (chatTypes.includes(msg.type))        handleChatMsg(msg)
    else if (msg.type === 'usage')                onUsageMsg(msg)
    else if (msg.type === 'log')                  appendLog(msg)
    else if (msg.type === 'metrics')              updateMetrics(msg)
    else if (msg.type === 'trace')                onTraceSpan(msg)
    else if (msg.type === 'tool_registered')      onToolRegistered(msg)
    else if (msg.type === 'tool_unregistered')    onToolUnregistered(msg)
  })
}
