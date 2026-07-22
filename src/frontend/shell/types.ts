import type { ThemeName } from './theme.js'

export type ViewConfig = {
  id: string
  title: string
  icon: string
  contentTag: string
  modes?: string[]
};

export type ViewRuntimeState = {
  id: string
  isOpen: boolean
  params: Record<string, any>
};

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

export type ToolCallItem = string | { name: string; arguments?: string }

export type Message = {
  id: string
  role: 'user' | 'assistant' | 'error'
  text: string
  reasoning?: string
  sources?: Source[]
  attachments?: Attachment[]
  timestamp: number
  toolCalls?: ToolCallItem[]
};

export type ActiveStream = {
  isActive: boolean
  toolCalls: ToolCallItem[]
  reasoning: string
  text: string
  sources: Source[]
  attachments: Attachment[]
};



// Agent is shell/agent-registry specific — stays here, not in the kit.
export type Agent = {
  mode: string
  displayName: string
  shortDesc: string
};

// Shape of `store.namespace('shell')`. The shell is just another namespace
// owner, symmetric with `store.namespace('<pluginId>')` for plugins.
// All plugin-leak keys have been removed — the docs and workflows plugins
// now own their state in their own namespaces.
export type ShellState = {
  theme: ThemeName
  isConnected: boolean
  isWaiting: boolean
  currentUserId: string | null
  currentUserRoles: string[]
  agents: Agent[]
  currentMode: string
  currentModeDisplayName: string
  messages: Message[]
  /** Persisted subset of recent messages (stripped of attachment payloads)
   *  used to restore the chat history across refreshes. */
  lastMessages: Message[]
  activeStream: ActiveStream
  views: Record<string, ViewRuntimeState>
  activeWorkspaceTab: string
  /** Left-to-right order of open workspace tab ids. */
  workspaceTabOrder: string[]
  sidebarWidth: number
};

declare module '@rorschach/webkit/runtime/store.js' {
  interface NamespaceRegistry {
    shell: ShellState
  }
}

