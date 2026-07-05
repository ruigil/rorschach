import { createTopic } from '../system/index.ts'

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

export type OutboundBroadcastEvent = { type: string; payload: string; key: string }

/** Topic for broadcasting messages to all connected clients. */
export const OutboundBroadcastTopic = createTopic<OutboundBroadcastEvent>('outbound.broadcast')

export type OutboundAdminBroadcastEvent = { type: string; payload: string; key: string }

/** Topic for broadcasting admin-only messages. */
export const OutboundAdminBroadcastTopic = createTopic<OutboundAdminBroadcastEvent>('outbound.admin.broadcast')

// ─── Domain event: emitted by cron actor to trigger a user-specific proactive message ───

export type CronTriggerEvent = { userId: string; text: string; traceId: string; parentSpanId: string }

/** Topic emitted when a cron job fires for a specific user. Session manager routes to that user's chatbot actor. */
export const CronTriggerTopic = createTopic<CronTriggerEvent>('cron.trigger.user')

export type HttpWsFrameEvent = {
  clientId: string
  userId: string
  roles: string[]
  frame: {
    type: string
    [key: string]: any
  }
}

/** Topic published when the HTTP/WS interface receives a custom client WebSocket frame. */
export const HttpWsFrameTopic = createTopic<HttpWsFrameEvent>('http.ws.frame')

export type NotebookChangeEvent =
  | { type: 'todosUpdated'; userId: string }
  | { type: 'journalUpdated'; userId: string; date: string }
  | { type: 'trackerUpdated'; userId: string; habit: string }

/** Topic published when notebook data is updated by coach tools (journal, tracker, or todos). */
export const NotebookChangeTopic = createTopic<NotebookChangeEvent>('notebook.change')


