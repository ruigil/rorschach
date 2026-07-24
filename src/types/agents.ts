import type { ActorDef, ActorRef } from '../system/index.ts'
import { createTopic } from '../system/index.ts'
import type { ApiMessage, LlmProviderMsg } from './llm.ts'
import type { ToolFilter, Tool } from './tools.ts'

export type AgentModelOptions = {
  model:         string
  maxToolLoops?: number
  toolFilter?:   ToolFilter
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

export type ContextView = Pick<
  ContextSnapshotEvent,
  'userId' | 'version' | 'recentMessages' | 'userContext' | 'toolSummaries' | 'timezone'
>


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

// ─── Per-(user, mode) agent factory options ───

export type AgentFactoryOpts = {
  userId:          string
  contextStoreRef: ActorRef<AgentContextMsg>
}

// ─── Agent descriptor ───

export type AgentDescriptor = {
  mode:         string
  displayName:  string
  shortDesc:    string
  role?:        string
  systemPrompt: string
  internalTools: Tool[]
  toolFilter?:   ToolFilter
  capabilities: { userVisible: boolean }
  model:        string
  maxToolLoops?: number
}

// Retained by mode (key = descriptor.mode / mode).
// Register with publishRetained; unregister with deleteRetained (tombstone payload below).
// Bare publish is not order-safe: late AgentRegistry subscribers only see retained entries.
export type AgentRegistrationEvent =
  | { type: 'register';   descriptor: AgentDescriptor }
  | { type: 'unregister'; mode:       string }

export const AgentRegistrationTopic = createTopic<AgentRegistrationEvent>('agent.registration')

export type AgentCatalogEvent = {
  agents: Array<{ mode: string; displayName: string; shortDesc: string }>
}
