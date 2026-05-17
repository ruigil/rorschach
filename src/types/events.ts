import { createTopic } from '../system/types.ts'

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
  clientId:      string
  text:          string
  attachments?:  MessageAttachment[]
  traceId:       string
  parentSpanId:  string
  isCron?:       boolean
}

/** Topic published when any interface (HTTP/WS, Signal, CLI) receives a message from a client. */
export const InboundMessageTopic = createTopic<InboundMessageEvent>('client.inbound')

// ─── Domain event: published when a client connects (any interface) ───

export type ClientConnectEvent = { clientId: string; userId: string; roles: string[] }

/** Topic published when a client connects via any interface. */
export const ClientConnectTopic = createTopic<ClientConnectEvent>('client.connect')

// ─── Domain event: published when a client disconnects (any interface) ───

export type ClientDisconnectEvent = { clientId: string }

/** Topic published when a client disconnects via any interface. */
export const ClientDisconnectTopic = createTopic<ClientDisconnectEvent>('client.disconnect')

// ─── Domain event: emit to send a message to a specific client (any interface) ───

export type OutboundMessageEvent = { clientId: string; text: string }

/** Topic for sending a message to a specific client. Emit to push text to any interface. */
export const OutboundMessageTopic = createTopic<OutboundMessageEvent>('client.outbound')

// ─── Domain event: emit to broadcast a message to all connected clients ───

export type OutboundBroadcastEvent = { text: string }

/** Topic for broadcasting a message to all connected clients across all interfaces. */
export const OutboundBroadcastTopic = createTopic<OutboundBroadcastEvent>('client.outbound.broadcast')

/** Topic for broadcasting admin-only observability messages to privileged clients. */
export const OutboundAdminBroadcastTopic = createTopic<OutboundBroadcastEvent>('client.outbound.admin.broadcast')

// ─── Domain event: emitted by cron actor to trigger a user-specific proactive message ───

export type CronTriggerEvent = { userId: string; text: string; traceId: string; parentSpanId: string }

/** Topic emitted when a cron job fires for a specific user. Session manager routes to that user's chatbot actor. */
export const CronTriggerTopic = createTopic<CronTriggerEvent>('cron.trigger.user')

// ─── Domain event: published when a chatbot turn completes ───

export type UserStreamEvent = {
  userId:        string
  userText:      string
  assistantText: string
  timestamp:     number
  injected?:     boolean
}

/** Topic emitted when a chatbot LLM turn completes. Subscribe to persist conversation history. */
export const UserStreamTopic = createTopic<UserStreamEvent>('user.stream')
