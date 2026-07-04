// ─── Connection service ───
//
// Owns the WebSocket transport so it stays out of reactive state. Exposes a
// narrow surface: `connect()`, `send(frame)`, `disconnect()`.
//
// Actions use the exported `send(...)` function from this service instead of
// reaching into the store for a `WebSocket` handle.

import { store } from './store.js'

let socket: WebSocket | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null

type MessageHandler = (msg: any) => void
let messageHandler: MessageHandler | null = null

/** Register a callback for incoming WebSocket messages. */
export function onMessage(handler: MessageHandler): void {
  messageHandler = handler
}

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
    const shell = store.namespace<any>('shell')
    shell.set('isConnected', true)

    // Restore saved mode on reconnect/refresh (persisted via the store)
    const savedMode = shell.get('currentMode')
    if (savedMode) {
      send({ type: 'cognitive.switchMode', mode: savedMode })
    }

    const chatTab = document.querySelector('[data-tab="chat"].active')
    if (chatTab) {
      ;(document.getElementById('input') as HTMLElement | null)?.focus()
    }
  })

  socket.addEventListener('close', () => {
    const shell = store.namespace<any>('shell')
    shell.set('isConnected', false)
    shell.set('isWaiting', false)
    socket = null
    reconnectTimer = setTimeout(connect, 2000)
  })

  socket.addEventListener('error', () => socket?.close())

  socket.addEventListener('message', (e) => {
    let msg: any
    try {
      msg = JSON.parse(e.data)
    } catch {
      return
    }
    if (messageHandler) {
      messageHandler(msg)
    }
  })
}
