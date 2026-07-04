import type { ThemeName } from '../shell/theme.js'
import type {
  Attachment,
  Source,
  Message,
  ActiveStream,
  Topic,
  Actor,
  LogEvent,
  TraceSpan,
  UsageEntry,
} from '@rorschach/webkit/types.js'
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

// Re-export the kit types so existing shell code that imports from
// `./types/state.js` keeps working. These are the neutral data shapes the
// kit primitives render; the kit owns them, the shell re-exports for
// convenience.
export type { Attachment, Source, Message, ActiveStream, Topic, Actor, LogEvent, TraceSpan, UsageEntry }

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
  tools: Record<string, { type: 'function'; function: { name: string; description: string; parameters: object } }>
  messages: Message[]
  /** Persisted subset of recent messages (stripped of attachment payloads)
   *  used to restore the chat history across refreshes. */
  lastMessages: Message[]
  activeStream: ActiveStream
  views: Record<string, ViewRuntimeState>
  activeWorkspaceTab: string
  sidebarWidth: number
};

declare module '@rorschach/webkit/runtime/store.js' {
  interface NamespaceRegistry {
    shell: ShellState
  }
}

