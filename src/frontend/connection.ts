import { store } from './store.js'
import { type WSFrame } from './types/websocket.js'
import { toolActionLabel } from './core/utils.js'

const frameHandlers: Record<string, (msg: any) => void> = {
  chunk: (msg) => {
    store.updateActiveStream({
      isActive: true,
      text: store.get('activeStream').text + msg.text,
      toolingLabel: undefined,
    })
  },
  reasoningChunk: (msg) => {
    store.updateActiveStream({
      isActive: true,
      reasoning: store.get('activeStream').reasoning + msg.text,
      toolingLabel: undefined,
    })
  },
  tooling: (msg) => {
    store.updateActiveStream({
      isActive: true,
      toolingLabel: toolActionLabel(msg.tools || [])
    })
  },
  sources: (msg) => store.updateActiveStream({ sources: msg.sources }),
  attachments: (msg) => store.updateActiveStream({ attachments: msg.attachments }),
  done: () => store.commitActiveStream(),
  error: (msg) => store.commitActiveStream('error', msg.text),
  agents: (msg) => store.set('agents', Array.isArray(msg.agents) ? msg.agents : []),
  modeChanged: (msg) => store.setMode(msg.mode, msg.displayName),
  plannerMode: (msg) => {
    if (msg.active) store.setMode('planner', 'Planner')
    else if (store.get('currentMode') === 'planner') store.setMode('chatbot', 'Chatbot')
  },
  log: (msg) => store.addLog(msg),
  metrics: (msg) => {
    if (msg.actors) store.set('actors', msg.actors)
    if (msg.topics) store.set('topics', msg.topics)
  },
  trace: (msg) => store.set('traces', [...store.get('traces'), msg]),
  usage: (msg) => store.set('usage', [...store.get('usage'), msg]),
  tool_registered: (msg) => store.set('tools', { ...store.get('tools'), [msg.name]: msg.schema }),
  tool_unregistered: (msg) => {
    const nextTools = { ...store.get('tools') }
    delete nextTools[msg.name]
    store.set('tools', nextTools)
  },
  planGraph: (msg) => store.set('currentPlanGraph', msg),
}


function dispatchFrame(msg: WSFrame) {
  const handler = frameHandlers[msg.type]
  if (handler) handler(msg)
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
