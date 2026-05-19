import { store } from './store.js'

const logoutBtn = document.getElementById('logout-btn')

logoutBtn?.addEventListener('click', async () => {
  await fetch(new URL('auth/logout', location.href), { method: 'POST' })
  window.location.href = new URL('auth/login.html', location.href).href
})

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

    const chatTypes = ['chunk', 'done', 'error', 'tooling', 'sources', 'attachments', 'reasoningChunk', 'plannerMode', 'modeChanged', 'agents']
    if      (chatTypes.includes(msg.type))        document.dispatchEvent(new CustomEvent('ws-message', { detail: msg, bubbles: true }))
    else if (msg.type === 'planGraph')            document.querySelector('r-plan-workspace')?.dispatchEvent(new CustomEvent('plan-graph', { detail: msg, bubbles: true }))
    else if (msg.type === 'usage')                document.getElementById('obs-costs')?.dispatchEvent(new CustomEvent('usage', { detail: msg, bubbles: true }))
    else if (msg.type === 'log')                  document.getElementById('log-stream')?.dispatchEvent(new CustomEvent('log', { detail: msg, bubbles: true }))
    else if (msg.type === 'metrics')              document.getElementById('actor-tree')?.dispatchEvent(new CustomEvent('metrics', { detail: msg, bubbles: true }))
    else if (msg.type === 'trace')                document.getElementById('obs-traces-list')?.dispatchEvent(new CustomEvent('trace', { detail: msg, bubbles: true }))
    else if (msg.type === 'tool_registered')      document.getElementById('tools-list')?.dispatchEvent(new CustomEvent('tool-registered', { detail: msg, bubbles: true }))
    else if (msg.type === 'tool_unregistered')    document.getElementById('tools-list')?.dispatchEvent(new CustomEvent('tool-unregistered', { detail: msg, bubbles: true }))
  })
}
