import { store } from '@rorschach/frontend/webkit/store.js'
import { type WSFrame } from './types/websocket.js'
import { type TraceSpan, type UsageEntry, type LogEvent } from './types/state.js'
import { toolActionLabel } from '@rorschach/frontend/webkit/utils.js'
import { updateActiveStream, commitActiveStream, addLog } from './actions.js'
import { setMode } from '@rorschach/frontend/webkit/window-actions.js'
import { pluginHost } from './shell/plugin-host.js'

const shell = () => store.namespace<import('./types/state.js').ShellState>('shell')

const frameHandlers: Record<string, (msg: Record<string, any>) => void> = {
  chunk: (msg) => {
    updateActiveStream({
      isActive: true,
      text: shell().get('activeStream').text + msg.text,
      toolingLabel: undefined,
    })
  },
  reasoningChunk: (msg) => {
    updateActiveStream({
      isActive: true,
      reasoning: shell().get('activeStream').reasoning + msg.text,
      toolingLabel: undefined,
    })
  },
  tooling: (msg) => {
    updateActiveStream({
      isActive: true,
      toolingLabel: toolActionLabel(msg.tools || [])
    })
  },
  sources: (msg) => updateActiveStream({ sources: msg.sources }),
  attachments: (msg) => updateActiveStream({ attachments: msg.attachments }),
  done: () => commitActiveStream(),
  error: (msg) => commitActiveStream('error', msg.text),
  agents: (msg) => shell().set('agents', Array.isArray(msg.agents) ? msg.agents : []),
  modeChanged: (msg) => setMode(msg.mode, msg.displayName),
  plannerMode: (msg) => {
    if (msg.active) setMode('planner', 'Planner')
    else if (shell().get('currentMode') === 'planner') setMode('chatbot', 'Chatbot')
  },
  log: (msg) => addLog(msg as Partial<LogEvent> & { message: string }),
  metrics: (msg) => {
    if (msg.actors) shell().set('actors', msg.actors)
    if (msg.topics) shell().set('topics', msg.topics)
  },
  trace: (msg) => shell().set('traces', [...shell().get('traces'), msg as TraceSpan]),
  usage: (msg) => shell().set('usage', [...shell().get('usage'), msg as UsageEntry]),
  tool_registered: (msg) => shell().set('tools', { ...shell().get('tools'), [msg.name]: msg.schema }),
  tool_unregistered: (msg) => {
    const nextTools = { ...shell().get('tools') }
    delete nextTools[msg.name]
    shell().set('tools', nextTools)
  },
}

function dispatchFrame(msg: WSFrame) {
  if (msg.type === 'ui.surface') {
    pluginHost.dispatch(msg.reg)
    return
  }
  if (pluginHost.routeFrame(msg)) return
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
  shell().set('ws', ws)

  ws.addEventListener('open', () => {
    shell().set('isConnected', true)

    // Restore saved mode on reconnect/refresh
    const savedMode = typeof localStorage !== 'undefined' ? localStorage.getItem('rorschach.currentMode') : null;
    if (savedMode) {
      ws.send(JSON.stringify({ type: 'switchMode', mode: savedMode }));
    }

    const chatTab = document.querySelector('[data-tab="chat"].active')
    if (chatTab) {
      (document.getElementById('input') as HTMLElement | null)?.focus()
    }
  })

  ws.addEventListener('close', () => {
    shell().set('isConnected', false)
    shell().set('isWaiting', false)
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
