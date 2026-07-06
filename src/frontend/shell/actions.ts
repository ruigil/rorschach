import { store, isConnected, send } from '@rorschach/webkit';
import type { ShellState, Message, Attachment } from './types.js'
import { setMode } from './view-actions.js'

const shell = () => store.namespace<ShellState>('shell')

const toPersistedMessage = (msg: Message): Message => {
  return {
    ...msg,
    attachments: msg.attachments?.map(({ kind, name }) => ({ kind, name })),
  }
}

export const appendMessage = (msg: Message) => {
  const currentMessages = shell().get('messages')
  const nextMessages = [...currentMessages, msg]
  shell().set('messages', nextMessages)
  const nextPersisted = nextMessages.slice(-10).map(toPersistedMessage)
  shell().set('lastMessages', nextPersisted)
}

export const updateActiveStream = (patch: Partial<ShellState['activeStream']>) => {
  const active = shell().get('activeStream')
  shell().set('activeStream', { ...active, ...patch })
}

export const commitActiveStream = (role: 'assistant' | 'error' = 'assistant', text?: string) => {
  const active = shell().get('activeStream')
  if (!active.isActive) {
    return
  }
  const message: Message = {
    id: crypto.randomUUID(),
    role,
    text: text ?? active.text,
    reasoning: active.reasoning,
    sources: [...active.sources],
    attachments: [...active.attachments],
    timestamp: Date.now(),
    toolCalls: [...active.toolCalls],
  }
  appendMessage(message)
  shell().set('activeStream', {
    isActive: false,
    reasoning: '',
    text: '',
    sources: [],
    attachments: [],
    toolCalls: [],
  })
  shell().set('isWaiting', false)
}

export const switchMode = (mode: string) => {
  if (!mode || mode === shell().get('currentMode')) {
    return false
  }
  if (!isConnected()) {
    return false
  }
  const agent = shell().get('agents').find(agent => agent.mode === mode)
  setMode(mode, agent?.displayName ?? mode)
  send({ type: 'cognitive.switchMode', mode })
  return true
}

export const submitChatMessage = (text: string, attachments: Attachment[]) => {
  const isWaiting = shell().get('isWaiting')
  if ((!text && attachments.length === 0) || isWaiting) {
    return
  }

  appendMessage({
    id: crypto.randomUUID(),
    role: 'user',
    text,
    attachments,
    timestamp: Date.now(),
  })

  send({ text, attachments })
  shell().set('isWaiting', true)
  updateActiveStream({ isActive: true })
}

export const cancelChatMessage = () => {
  const isWaiting = shell().get('isWaiting')
  if (!isWaiting) return

  send({ type: 'cognitive.cancel' })
  commitActiveStream('error', 'Request cancelled.')
}

export const logout = async () => {
  await fetch(new URL('auth/logout', location.href), { method: 'POST' })
  window.location.href = new URL('auth/login.html', location.href).href
}
