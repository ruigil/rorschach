import { createTopic } from '../system/types.ts'

// ─── Domain event: published when a WebSocket message is received ───

export type WsMessageEvent = { clientId: string; text: string; images?: string[]; audio?: string; traceId: string; parentSpanId: string }

/** Topic for WebSocket message domain events. Subscribe to receive browser input. */
export const WsMessageTopic = createTopic<WsMessageEvent>('http.ws.message')

// ─── Domain event: published when a WebSocket client connects ───

export type WsConnectEvent = { clientId: string }

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

// ─── Domain event: published when a ReAct turn completes ───

export type MemoryTurnEvent = {
  userId:        string
  userText:      string
  assistantText: string
  timestamp:     number
}

/** Topic emitted when a ReAct LLM turn completes. Subscribe to persist conversation history. */
export const MemoryStreamTopic = createTopic<MemoryTurnEvent>('memory.turn')

// ─── Domain event: emitted when a POST /config request is received ───

export type HttpConfigPayload = Record<string, unknown>

/** Topic emitted when the browser POSTs new config. Subscribe in your app to apply config changes. */
export const HttpConfigTopic = createTopic<HttpConfigPayload>('http.config.post')

// ─── Domain event: emitted when a tool generates an image ───

export type ImageGeneratedEvent = {
  filePath:  string  // absolute path to the saved PNG file
  publicUrl: string  // relative URL path for HTTP clients, e.g. '/generated/uuid.png'
}

/** Topic emitted when a generated image has been saved to disk. Interfaces use this to deliver it to clients. */
export const ImageGeneratedTopic = createTopic<ImageGeneratedEvent>('image.generated')

// ─── Domain event: emitted when the TTS tool generates audio ───

export type AudioGeneratedEvent = {
  filePath:  string  // absolute path to the saved WAV file
  publicUrl: string  // relative URL path for HTTP clients, e.g. 'generated/uuid.wav'
}

/** Topic emitted when a generated audio file has been saved to disk. Interfaces use this to deliver it to clients. */
export const AudioGeneratedTopic = createTopic<AudioGeneratedEvent>('audio.generated')
