import { createTopic } from '../system/types.ts'

// ─── Domain event: published when a WebSocket message is received ───

export type WsMessageEvent = { clientId: string; text: string; images?: string[]; audio?: string; pdfs?: string[]; traceId: string; parentSpanId: string; isCron?: boolean }

/** Topic for WebSocket message domain events. Subscribe to receive browser input. */
export const WsMessageTopic = createTopic<WsMessageEvent>('http.ws.message')

// ─── Domain event: published when a WebSocket client connects ───

export type WsConnectEvent = { clientId: string; userId: string | null; roles: string[] }

/** Topic emitted when a new WebSocket client connects. Subscribe to send initial state to the client. */
export const WsConnectTopic = createTopic<WsConnectEvent>('http.ws.connect')

// ─── Domain event: published when a WebSocket client disconnects ───

export type WsDisconnectEvent = { clientId: string }

/** Topic emitted when a WebSocket client disconnects. */
export const WsDisconnectTopic = createTopic<WsDisconnectEvent>('http.ws.disconnect')

// ─── Domain event: emit to send a message to a specific WebSocket client ───

export type WsSendEvent = { clientId: string; text: string }

/** Topic for sending a message to a specific WebSocket client. Emit to push text to the browser. */
export const WsSendTopic = createTopic<WsSendEvent>('http.ws.send')

// ─── Domain event: emit to broadcast a message to all connected WebSocket clients ───

export type WsBroadcastEvent = { text: string }

/** Topic for broadcasting a message to all WebSocket clients. Emit to push text to every open connection. */
export const WsBroadcastTopic = createTopic<WsBroadcastEvent>('http.ws.broadcast')

// ─── Domain event: emitted by cron actor to trigger a user-specific proactive message ───

export type CronTriggerEvent = { userId: string; text: string; traceId: string; parentSpanId: string }

/** Topic emitted when a cron job fires for a specific user. Session manager routes to that user's chatbot actor. */
export const CronTriggerTopic = createTopic<CronTriggerEvent>('cron.trigger.user')

// ─── Domain event: published when a chatbot turn completes ───

export type MemoryTurnEvent = {
  userId:        string
  userText:      string
  assistantText: string
  timestamp:     number
}

/** Topic emitted when a chatbot LLM turn completes. Subscribe to persist conversation history. */
export const MemoryStreamTopic = createTopic<MemoryTurnEvent>('memory.turn')

// ─── Domain event: emitted when a POST /config request is received ───

export type HttpConfigPayload = Record<string, unknown>

/** Topic emitted when the browser POSTs new config. Subscribe in your app to apply config changes. */
export const HttpConfigTopic = createTopic<HttpConfigPayload>('http.config.post')

// ─── Domain event: publish to push the current flat config to the HTTP actor ───

export type ConfigSnapshotEvent = { config: Record<string, unknown> }

/** Publish to update the flat config snapshot served at GET /config. */
export const ConfigSnapshotTopic = createTopic<ConfigSnapshotEvent>('http.config.snapshot')
