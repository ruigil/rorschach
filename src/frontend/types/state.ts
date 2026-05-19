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
  // Add other fields as needed
}

export interface LogEvent {
  timestamp: number
  level: 'debug' | 'info' | 'warn' | 'error'
  source: string
  message: string
  data?: any
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
  ws: WebSocket | null
}
