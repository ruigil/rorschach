import { createTopic, type ActorRef } from '../system/index.ts'
import type { ApiMessage } from './llm.ts'
export type AgentModelOptions = {
  model:         string
  maxToolLoops?: number
}



// ─── Shared context protocol for session-hosted agents ───

export type ContextRecordSource = 'user' | 'assistant' | 'tool'

export type ToolSummary = {
  mode:      string
  toolName:  string
  summary:   string
  timestamp: number
}

export type ContextTurn = {
  seq:           number
  userId:        string
  userText:      string
  assistantText: string
  timestamp:     number
}


export type AgentContextMsg =
  | {
      type:       'append'
      messages:   ApiMessage[]
      mode:       string
      source?:    ContextRecordSource
      injected?:  boolean
      timestamp?: number
    }

export type ContextSnapshotEvent = {
  userId:        string
  version:       number
  recentMessages: ApiMessage[]
  turns:         ContextTurn[]
  userContext:   string | null
  toolSummaries: ToolSummary[]
  timezone?:     string | null
}

export const ContextSnapshotTopic = createTopic<ContextSnapshotEvent>('context.snapshot')

import type { PermissionContext } from '../system/permissions/types.ts'

// ─── Per-(user, mode) agent factory options ───

export type AgentFactoryOpts = {
  userId:          string
  contextStoreRef: ActorRef<AgentContextMsg>
  permissionContext: PermissionContext
}

export type AgentDescriptor = {
  mode:         string
  displayName:  string
  shortDesc:    string
  role?:        string
  systemPrompt: string
  agentSCRs?:   string[]
  capabilities: { userVisible: boolean }
  model:        string
  maxToolLoops?: number
  outputSchema?: Record<string, any>
}
