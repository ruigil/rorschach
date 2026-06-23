import type { ActorDef, ActorRef } from '../system/index.ts'
import { createTopic } from '../system/index.ts'
import type { ApiMessage, LlmProviderMsg } from './llm.ts'
import type { ToolFilter } from './tools.ts'

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
}

export const ContextSnapshotTopic = createTopic<ContextSnapshotEvent>('context.snapshot')

// ─── Per-(user, mode) agent factory options ───

export type AgentFactoryOpts = {
  userId:          string
  llmRef:          ActorRef<LlmProviderMsg>
  contextStoreRef: ActorRef<AgentContextMsg>
}

// ─── Agent descriptor ───

export type AgentDescriptor = {
  mode:         string
  displayName:  string
  shortDesc:    string
  factory:      (opts: AgentFactoryOpts) => ActorDef<any, any>
  capabilities: { userVisible: boolean }
}

export type AgentRegistrationEvent =
  | { type: 'register';   descriptor: AgentDescriptor }
  | { type: 'unregister'; mode:       string }

export const AgentRegistrationTopic = createTopic<AgentRegistrationEvent>('agent.registration')

export type SwitchAgentEvent = {
  userId:   string
  mode:     string
  source:   'user' | 'llm' | 'programmatic'
  reason?:  string
}

export const SwitchAgentTopic = createTopic<SwitchAgentEvent>('agent.switch')

export type AgentCatalogEvent = {
  agents: Array<{ mode: string; displayName: string; shortDesc: string }>
}

export const AgentCatalogTopic = createTopic<AgentCatalogEvent>('agent.catalog')

export type SessionLifecycleEvent =
  | { type: 'sessionStarted';  userId: string; defaultMode: string; timestamp: number }
  | { type: 'sessionEnded';    userId: string; reason: 'lastDisconnect' | 'contextStoreCrash'; timestamp: number }
  | { type: 'modeActivated';   userId: string; mode: string; previousMode: string; source: 'user' | 'llm' | 'programmatic' | 'crashFallback'; timestamp: number }
  | { type: 'presencePresent'; userId: string; source: 'http' | 'signal' | 'cli'; timestamp: number }
  | { type: 'presenceAbsent';  userId: string; source: 'http' | 'signal' | 'cli'; timestamp: number }

export const SessionLifecycleTopic = createTopic<SessionLifecycleEvent>('session.lifecycle')
