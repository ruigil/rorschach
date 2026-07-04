// ─── Frame dispatcher ───
//
// Receives WebSocket messages and routes them to the store or plugin-host.
// Placed in shell to maintain dependency inversion boundaries (so webkit
// remains generic and does not import shell actions or plugin host).

import { store, toolActionLabel } from '@rorschach/webkit';
import type { WSFrame } from '../types/websocket.js'
import type { TraceSpan, UsageEntry, LogEvent, ShellState } from '../types/state.js'
import { updateActiveStream, commitActiveStream, addLog } from './actions.js'
import { setMode } from './view-actions.js'
import { pluginHost } from './plugin-host.js'

const shell = () => store.namespace<ShellState>('shell')

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

export const dispatchFrame = (msg: WSFrame) => {
  if (msg.type === 'ui.surface') {
    pluginHost.dispatch(msg.reg)
    return
  }
  if (pluginHost.routeFrame(msg)) return
  const handler = frameHandlers[msg.type]
  if (handler) handler(msg)
}
