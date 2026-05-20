export interface Agent {
  mode: string
  displayName: string
  shortDesc: string
}

export interface Topic {
  topic: string
  subscribers: string[]
}

export interface Actor {
  name: string
  status: 'running' | 'stopped' | 'error' | null
  messagesProcessed: number
}

export interface LogEvent {
  timestamp: number
  level: 'debug' | 'info' | 'warn' | 'error'
  source: string
  message: string
  data?: any
}

export interface Attachment {
  kind: 'image' | 'audio' | 'video' | 'file' | 'pdf'
  url?: string
  data?: string
  name?: string
}

export interface Source {
  url: string
  title: string
  snippet?: string
}

export interface Message {
  id: string
  role: 'user' | 'assistant' | 'error'
  text: string
  reasoning?: string
  sources?: Source[]
  attachments?: Attachment[]
  timestamp: number
}

export interface ActiveStream {
  isActive: boolean
  toolingLabel?: string
  reasoning: string
  text: string
  sources: Source[]
  attachments: Attachment[]
}

export interface RorschachState {
  isConnected: boolean
  isWaiting: boolean
  currentUserId: string | null
  currentUserRoles: string[]
  agents: Agent[]
  currentMode: string
  currentModeDisplayName: string
  topics: Topic[]
  actors: Actor[]
  logs: LogEvent[]
  traces: any[]
  usage: any[]
  tools: Record<string, any>
  ws: WebSocket | null
  messages: Message[]
  activeTab: string
  observeActiveTab: string
  activeStream: ActiveStream
  currentPlanGraph: any | null
  planWorkspaceOpen: boolean
}
