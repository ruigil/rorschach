// ─── Neutral data shapes rendered by frontend/webkit primitives ───
//
// These describe the data the kit's rendering primitives consume (a log
// entry, a chat message, an actor snapshot) — not shell state. The shell's
// `ShellState` aggregates them; plugins may use the same shapes or their
// own. The kit must not import shell or plugin types, so the shapes live
// here and both the shell and plugins import them from the kit.

export type Attachment = {
  kind: 'image' | 'audio' | 'video' | 'file' | 'pdf'
  url?: string
  data?: string
  name?: string
};

export type Source = {
  url: string
  title: string
  snippet?: string
};

export type Message = {
  id: string
  role: 'user' | 'assistant' | 'error'
  text: string
  reasoning?: string
  sources?: Source[]
  attachments?: Attachment[]
  timestamp: number
};

export type ActiveStream = {
  isActive: boolean
  toolingLabel?: string
  reasoning: string
  text: string
  sources: Source[]
  attachments: Attachment[]
};

export type Topic = {
  topic: string
  subscribers: string[]
};

export type Actor = {
  name: string
  status: 'running' | 'stopped' | 'error' | null
  messagesProcessed: number
  messagesReceived?: number
  messagesFailed?: number
  mailboxSize?: number
  processingTime?: {
    avg?: number
    min?: number
    max?: number
  }
  state?: unknown
};

export type LogEvent = {
  timestamp: number
  level: 'debug' | 'info' | 'warn' | 'error'
  source: string
  message: string
  data?: Record<string, unknown>
};

export type TraceSpan = {
  traceId: string
  spanId: string
  parentSpanId: string | null
  actor: string
  operation: string
  timestamp: number
  durationMs?: number
  status: string
  data?: Record<string, unknown>
};

export type UsageEntry = {
  role: string
  model: string
  inputTokens: number
  outputTokens: number
  contextWindow: number | null
  cost: number
};
