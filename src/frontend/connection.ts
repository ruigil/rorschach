import { store } from './store.js'
import { type WSFrame } from './types/websocket.js'
import { type TraceSpan, type UsageEntry, type WorkflowGraph, type LogEvent } from './types/state.js'
import { toolActionLabel } from './core/utils.js'
import { updateActiveStream, commitActiveStream, setMode, addLog } from './actions.js'

export const WORKFLOW_RUN_UPDATED_EVENT = 'workflow-run-updated'

const frameHandlers: Record<string, (msg: Record<string, any>) => void> = {
  chunk: (msg) => {
    updateActiveStream({
      isActive: true,
      text: store.get('activeStream').text + msg.text,
      toolingLabel: undefined,
    })
  },
  reasoningChunk: (msg) => {
    updateActiveStream({
      isActive: true,
      reasoning: store.get('activeStream').reasoning + msg.text,
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
  agents: (msg) => store.set('agents', Array.isArray(msg.agents) ? msg.agents : []),
  modeChanged: (msg) => setMode(msg.mode, msg.displayName),
  plannerMode: (msg) => {
    if (msg.active) setMode('planner', 'Planner')
    else if (store.get('currentMode') === 'planner') setMode('chatbot', 'Chatbot')
  },
  log: (msg) => addLog(msg as Partial<LogEvent> & { message: string }),
  metrics: (msg) => {
    if (msg.actors) store.set('actors', msg.actors)
    if (msg.topics) store.set('topics', msg.topics)
  },
  trace: (msg) => store.set('traces', [...store.get('traces'), msg as TraceSpan]),
  usage: (msg) => store.set('usage', [...store.get('usage'), msg as UsageEntry]),
  tool_registered: (msg) => store.set('tools', { ...store.get('tools'), [msg.name]: msg.schema }),
  tool_unregistered: (msg) => {
    const nextTools = { ...store.get('tools') }
    delete nextTools[msg.name]
    store.set('tools', nextTools)
  },
  workflowGraph: (msg) => store.set('currentWorkflowGraph', msg as WorkflowGraph),
  workflowRunUpdated: (msg) => {
    window.dispatchEvent(new CustomEvent(WORKFLOW_RUN_UPDATED_EVENT, { detail: msg }))
  },
  docWorkspace: (msg) => {
    store.set('currentDocArtifact', msg.artifactName);
    store.set('docWorkspaceOpen', !!msg.artifactName);
  },
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
