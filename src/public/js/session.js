import { store } from './store.js'

let initialized = false

function modeLabel(mode, displayName = '') {
  if (displayName) return displayName
  if (!mode) return 'Mode'
  return mode.charAt(0).toUpperCase() + mode.slice(1)
}

function setMode(mode, displayName = '') {
  store.set('currentMode', mode)
  store.set('currentModeDisplayName', displayName || modeLabel(mode))
}

function handleSessionFrame(msg) {
  if (msg.type === 'agents') {
    store.set('agents', Array.isArray(msg.agents) ? msg.agents : [])
  } else if (msg.type === 'modeChanged') {
    setMode(msg.mode, msg.displayName)
  } else if (msg.type === 'plannerMode') {
    if (msg.active) setMode('planner', 'Planner')
    else if (store.get('currentMode') === 'planner') setMode('chatbot', 'Chatbot')
  }
}

export function switchMode(mode) {
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
  document.addEventListener('ws-message', (event) => handleSessionFrame(event.detail))
}

