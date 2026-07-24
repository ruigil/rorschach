import { createTopic } from '../system/index.ts'

// ─── Strongly Typed Domain Frame Names ─────────────────────────────────────

export type CognitiveFrameType =
  | 'cognitive.agents.request'
  | 'cognitive.agents.updated'
  | 'cognitive.switchMode'
  | 'cognitive.cancel'

export type MemoryFrameType =
  | 'memory.kgraph.request'
  | 'memory.kgraph.updated'
  | 'memory.kgraph.changed'

export type ToolsFrameType =
  | 'tools.list.request'
  | 'tools.registered'
  | 'tools.unregistered'

export type ObservabilityFrameType =
  | 'observability.log.entry'
  | 'observability.metrics.updated'
  | 'observability.trace.span'
  | 'observability.usage.entry'

export type NotebookFrameType =
  | 'notebook.todos.request'
  | 'notebook.todos.list'
  | 'notebook.todos.complete'
  | 'notebook.todos.delete'
  | 'notebook.journal.months.request'
  | 'notebook.journal.months'
  | 'notebook.journal.entry.request'
  | 'notebook.journal.entry'
  | 'notebook.tracker.habits.request'
  | 'notebook.tracker.habits'
  | 'notebook.tracker.entries.request'
  | 'notebook.tracker.entries'
  | 'notebook.tracker.stats.request'
  | 'notebook.tracker.stats'

export type SystemFrameType =
  | CognitiveFrameType
  | MemoryFrameType
  | ToolsFrameType
  | ObservabilityFrameType
  | NotebookFrameType

/** Strongly-typed frame type with autocomplete for known domain frames and string fallback for dynamic plugin frames. */
export type FrameType = SystemFrameType | (string & {})

// ─── Message attachments ───────────────────────────────────────────────────
export type MessageAttachmentKind = 'image' | 'audio' | 'video' | 'pdf' | 'file'

export type MessageAttachment = {
  kind:      MessageAttachmentKind
  url:       string   // Public URL or absolute local file path
  name?:     string   // Original filename
  alt?:      string   // Description/ALT text
  mimeType?: string
  data?:     string   // Base64 data (used during inbound ingestion before saving to disk)
}

// ─── Domain event: published when a client sends a message (any interface) ───

export type InboundMessageEvent = {
  userId:        string
  text:          string
  attachments?:  MessageAttachment[]
  traceId:       string
  parentSpanId:  string
}

/** Topic published when any interface (HTTP/WS, Signal, CLI) receives a message from a client. */
export const InboundMessageTopic = createTopic<InboundMessageEvent>('user.inbound')

export type UserPresenceEvent =
  | { status: 'present'; userId: string; source: 'http' | 'signal' | 'cli' }
  | { status: 'absent'; userId: string; source: 'http' | 'signal' | 'cli' }

/** Retained topic describing currently active users across interfaces. */
export const UserPresenceTopic = createTopic<UserPresenceEvent>('user.presence')

// ─── Domain event: emit to send a message to a specific user (any interface) ───

export type OutboundUserMessageEvent = { userId: string; text: string }

/** Topic for sending a message to a specific user. Emit to push text to any interface. */
export const OutboundUserMessageTopic = createTopic<OutboundUserMessageEvent>('user.outbound')

// ─── Domain event: emit to broadcast a message to all connected clients ───

export type OutboundBroadcastEvent = { type: FrameType; payload: any; key: string; isTombstone?: boolean }

/** Topic for broadcasting messages to all connected clients. */
export const OutboundBroadcastTopic = createTopic<OutboundBroadcastEvent>('outbound.broadcast')

export type OutboundAdminBroadcastEvent = { type: FrameType; payload: any; key: string; isTombstone?: boolean }

/** Topic for broadcasting admin-only messages. */
export const OutboundAdminBroadcastTopic = createTopic<OutboundAdminBroadcastEvent>('outbound.admin.broadcast')

export type HttpWsFrameEvent = {
  clientId: string
  userId: string
  roles: string[]
  frame: {
    type: FrameType
    [key: string]: any
  }
}

/** Topic published when the HTTP/WS interface receives a custom client WebSocket frame. */
export const HttpWsFrameTopic = createTopic<HttpWsFrameEvent>('http.ws.frame')

export type TraceSpan = {
  traceId: string        // one per user request
  spanId: string         // unique per logical operation
  parentSpanId?: string  // nesting — children share the request span as parent
  actor: string          // actor that emitted this span
  operation: string      // e.g. 'request', 'chatbot', 'llm-call', 'tool-invoke', 'llm-response'
  status: 'started' | 'done' | 'error'
  timestamp: number      // ms epoch (start time on 'started', end time on 'done'/'error')
  durationMs?: number    // elapsed — only set on 'done' and 'error'
  data?: Record<string, unknown>
}
