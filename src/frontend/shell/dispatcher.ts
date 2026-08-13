// ─── Frame dispatcher ───
//
// Receives WebSocket messages and routes them to the store or plugin-host.

import { store } from '@rorschach/webkit';
import type { ShellState } from './types.js'
import { updateActiveStream, commitActiveStream } from './actions.js'
import { setMode } from './view-actions.js'
import { pluginHost } from './plugin-host.js'

const shell = () => store.namespace<ShellState>('shell')

const handleStreamChunk = (msg: Record<string, any>) => {
  const type = msg.type // 'start' | 'chunk' | 'end' | 'error'
  if (type === 'start') {
    updateActiveStream({
      isActive: true,
      text: '',
      reasoning: '',
      toolCalls: [],
    })
  } else if (type === 'chunk' && msg.chunk) {
    if (msg.chunk.kind === 'text') {
      updateActiveStream({
        isActive: true,
        text: shell().get('activeStream').text + msg.chunk.text,
      })
    } else if (msg.chunk.kind === 'reasoning') {
      updateActiveStream({
        isActive: true,
        reasoning: shell().get('activeStream').reasoning + msg.chunk.text,
      })
    }
  } else if (type === 'end') {
    commitActiveStream()
  } else if (type === 'error') {
    commitActiveStream('error', msg.error || 'Unknown streaming error')
  }
}

const frameHandlers: Record<string, (msg: Record<string, any>) => void> = {
  chunk: (msg) => {
    updateActiveStream({
      isActive: true,
      text: shell().get('activeStream').text + msg.text,
    })
  },
  reasoningChunk: (msg) => {
    updateActiveStream({
      isActive: true,
      reasoning: shell().get('activeStream').reasoning + msg.text,
    })
  },
  tooling: (msg) => {
    const newTools = msg.tools || [];
    const current = shell().get('activeStream').toolCalls || [];
    updateActiveStream({
      isActive: true,
      toolCalls: [...current, ...newTools],
    })
  },
  sources: (msg) => updateActiveStream({ sources: msg.sources }),
  attachments: (msg) => updateActiveStream({ attachments: msg.attachments }),
  done: () => commitActiveStream(),
  error: (msg) => commitActiveStream('error', msg.text),
  agents: (msg) => shell().set('agents', Array.isArray(msg.agents) ? msg.agents : []),
  'cognitive.agents.updated': (msg) => shell().set('agents', Array.isArray(msg.agents) ? msg.agents : []),
  modeChanged: (msg) => setMode(msg.mode, msg.displayName)
}

export const dispatchFrame = (msg: Record<string, any>) => {
  if (msg.type === 'ui.surface') {
    pluginHost().dispatch(msg.reg)
    return
  }
  if (pluginHost().routeFrame(msg)) return

  // Task 5.3: Intercept and parse out-of-band StreamChunk frames directly.
  // A StreamChunk has runId and spanId fields.
  if (msg.runId && msg.spanId) {
    handleStreamChunk(msg)
    return
  }

  const handler = frameHandlers[msg.type]
  if (handler) handler(msg)
}
