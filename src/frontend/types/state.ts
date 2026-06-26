import type { Tab, ObserveTab } from '../constants.js'
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
} from '@rorschach/frontend/webkit/types.js'
import type { WindowRuntimeState } from '@rorschach/frontend/webkit/host-types.js'

// Re-export the kit types so existing shell code that imports from
// `./types/state.js` keeps working. These are the neutral data shapes the
// kit primitives render; the kit owns them, the shell re-exports for
// convenience.
export type { Attachment, Source, Message, ActiveStream, Topic, Actor, LogEvent, TraceSpan, UsageEntry, WindowRuntimeState }

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
  windows: Record<string, WindowRuntimeState>
  activeWindowIds: string[]
  activeWorkspaceTab: string
};
