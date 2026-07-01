// ─── Connection service ───
//
// Owns the WebSocket transport so it stays out of reactive state. Exposes a
// narrow surface: `connect()`, `send(frame)`, `disconnect()`. Inbound frames
// are dispatched to the store / plugin host via `dispatchFrame`, which was
// previously inlined in `connection.ts`.
//
// `connection.ts` re-exports `connect` so existing callers (r-shell) keep
// working unchanged. Actions use `connection.send(...)` instead of reaching
// into the store for a `WebSocket` handle.

import { store } from '@rorschach/frontend/webkit/store.js'
import type { WSFrame } from '../types/websocket.js'
import type { TraceSpan, UsageEntry, LogEvent, ShellState } from '../types/state.js'
import { toolActionLabel } from '@rorschach/frontend/webkit/utils.js'
import { updateActiveStream, commitActiveStream, addLog } from '../actions.js'
import { setMode } from './view-actions.js'
import { pluginHost } from './plugin-host.js'

const shell = () => store.namespace<ShellState>('shell')

let socket: WebSocket | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null

// ─── Frame dispatch ───

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
      toolingLabel: toolActionLabel(msg.tools || []),
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

const dispatchFrame = (msg: WSFrame) => {
  if (msg.type === 'ui.surface') {
    pluginHost.dispatch(msg.reg)
    return
  }
  if (pluginHost.routeFrame(msg)) return
  const handler = frameHandlers[msg.type]
  if (handler) handler(msg)
}

// ─── Transport ───

/** Whether the socket is open and ready to send. */
export function isConnected(): boolean {
  return socket?.readyState === WebSocket.OPEN
}

/** Send a JSON frame to the backend. No-op if the socket isn't open. */
export function send(frame: object): void {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(frame))
  }
}

/** Close the current socket and cancel any pending reconnect. */
export function disconnect(): void {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  if (socket) {
    socket.close()
    socket = null
  }
}

/** Open the WebSocket, authenticating via a one-time ticket. Reconnects
 *  automatically on close. Called once by `r-shell._bootstrap()`. */
export async function connect(): Promise<void> {
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

  socket = new WebSocket(wsUrl.href)

  socket.addEventListener('open', () => {
    shell().set('isConnected', true)

    // Restore saved mode on reconnect/refresh (persisted via the store)
    const savedMode = shell().get('currentMode')
    if (savedMode) {
      send({ type: 'cognitive.switchMode', mode: savedMode })
    }

    const chatTab = document.querySelector('[data-tab="chat"].active')
    if (chatTab) {
      ;(document.getElementById('input') as HTMLElement | null)?.focus()
    }
  })

  socket.addEventListener('close', () => {
    shell().set('isConnected', false)
    shell().set('isWaiting', false)
    socket = null
    reconnectTimer = setTimeout(connect, 2000)
  })

  socket.addEventListener('error', () => socket?.close())

  socket.addEventListener('message', (e) => {
    let msg: WSFrame
    try {
      msg = JSON.parse(e.data)
    } catch {
      return
    }
    dispatchFrame(msg)
  })
}
