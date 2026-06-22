import { store } from '@rorschach/frontend/webkit/store.js'
import type { ShellState, Message, LogEvent, Attachment } from './types/state.js'

const shell = () => store.namespace<ShellState>('shell')

export function addLog(log: Partial<LogEvent> & { message: string }) {
  const currentLogs = shell().get('logs')
  const entry: LogEvent = {
    timestamp: log.timestamp ?? Date.now(),
    level: log.level ?? 'info',
    source: log.source ?? '',
    message: log.message,
    data: log.data,
  }
  shell().set('logs', [entry, ...currentLogs].slice(0, 500))
}

function toPersistedMessage(msg: Message): Message {
  return {
    ...msg,
    attachments: msg.attachments?.map(({ kind, name }) => ({ kind, name })),
  }
}

export function appendMessage(msg: Message) {
  const currentMessages = shell().get('messages')
  const nextMessages = [...currentMessages, msg]
  shell().set('messages', nextMessages)
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem('rorschach.lastMessages', JSON.stringify(nextMessages.slice(-10).map(toPersistedMessage)))
  }
}

export function updateActiveStream(patch: Partial<ShellState['activeStream']>) {
  const active = shell().get('activeStream')
  shell().set('activeStream', { ...active, ...patch })
}

export function commitActiveStream(role: 'assistant' | 'error' = 'assistant', text?: string) {
  const active = shell().get('activeStream')
  const message: Message = {
    id: crypto.randomUUID(),
    role,
    text: text ?? active.text,
    reasoning: active.reasoning,
    sources: [...active.sources],
    attachments: [...active.attachments],
    timestamp: Date.now(),
  }
  appendMessage(message)
  shell().set('activeStream', {
    isActive: false,
    reasoning: '',
    text: '',
    sources: [],
    attachments: [],
  })
  shell().set('isWaiting', false)
}

export function switchMode(mode: string) {
  const ws = shell().get('ws')
  if (!mode || mode === shell().get('currentMode') || ws?.readyState !== WebSocket.OPEN) {
    return false
  }
  ws.send(JSON.stringify({ type: 'switchMode', mode }))
  return true
}

export function submitChatMessage(text: string, attachments: Attachment[]) {
  const ws = shell().get('ws')
  const isWaiting = shell().get('isWaiting')
  if ((!text && attachments.length === 0) || ws?.readyState !== WebSocket.OPEN || isWaiting) {
    return
  }

  appendMessage({
    id: crypto.randomUUID(),
    role: 'user',
    text,
    attachments,
    timestamp: Date.now(),
  })

  ws.send(JSON.stringify({ text, attachments }))
  shell().set('isWaiting', true)
  updateActiveStream({ isActive: true })
}

export async function logout() {
  await fetch(new URL('auth/logout', location.href), { method: 'POST' })
  window.location.href = new URL('auth/login.html', location.href).href
}
