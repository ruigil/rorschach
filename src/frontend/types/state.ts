import type { Tab, ObserveTab } from '../constants.js'

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
  data?: Record<string, unknown>
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

export interface TraceSpan {
  traceId: string
  spanId: string
  parentSpanId: string | null
  actor: string
  operation: string
  timestamp: number
  durationMs?: number
  status: string
  data?: Record<string, unknown>
}

export interface UsageEntry {
  role: string
  model: string
  inputTokens: number
  outputTokens: number
  contextWindow: number | null
  cost: number
}

export interface PlanGraphNode {
  id: string
  label: string
  description?: string
  validationCriteria?: string
  dependencies: string[]
  dependents: string[]
}

export interface PlanGraph {
  planId?: string
  plan?: { goal: string; createdAt: string; taskCount: number }
  nodes: PlanGraphNode[]
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
  traces: TraceSpan[]
  usage: UsageEntry[]
  tools: Record<string, { type: 'function'; function: { name: string; description: string; parameters: object } }>
  ws: WebSocket | null
  messages: Message[]
  activeTab: Tab
  observeActiveTab: ObserveTab
  activeStream: ActiveStream
  currentPlanGraph: PlanGraph | null
  planWorkspaceOpen: boolean
  docWorkspaceOpen: boolean
  currentDocArtifact: string | null
  isChatUndocked: boolean
  windows: Record<string, WindowRuntimeState>
  activeWindowIds: string[]
  activeWorkspaceTab: string
}

export interface WindowRuntimeState {
  id: string
  isOpen: boolean
  isDocked: boolean
  isMinimized: boolean
  x: number
  y: number
  w: number
  h: number
  zIndex: number
  params: Record<string, any>
}
