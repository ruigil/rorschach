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

export type OutboundBroadcastEvent = { text: string }

/** Topic for broadcasting admin-only observability messages to privileged clients. */
export const OutboundAdminBroadcastTopic = createTopic<OutboundBroadcastEvent>('admin.outbound.broadcast')

// ─── Domain event: emitted by cron actor to trigger a user-specific proactive message ───

export type CronTriggerEvent = { userId: string; text: string; traceId: string; parentSpanId: string }

/** Topic emitted when a cron job fires for a specific user. Session manager routes to that user's chatbot actor. */
export const CronTriggerTopic = createTopic<CronTriggerEvent>('cron.trigger.user')

