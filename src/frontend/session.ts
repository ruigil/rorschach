import { store } from './store.js'

let initialized = false

export function switchMode(mode: string) {
  const ws = store.get('ws')
  if (!mode || mode === store.get('currentMode') || ws?.readyState !== WebSocket.OPEN) {
    return false
  }
  ws.send(JSON.stringify({ type: 'switchMode', mode }))
  return true
}

export function initSession() {
  if (initialized) return
  initialized = true
}
