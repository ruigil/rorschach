import type { ActorDef, ActorRef } from '../system/types.ts'
import { createTopic } from '../system/types.ts'
import type { ApiMessage, LlmProviderMsg } from './llm.ts'

// ─── Shared context protocol for session-hosted agents ───

export type ContextRecordSource = 'user' | 'assistant' | 'tool'

export type ToolSummary = {
  mode:      string
  toolName:  string
  summary:   string
  timestamp: number
}

export type AgentContextMsg =
  | {
      type:       'append'
      messages:   ApiMessage[]
      mode:       string
      source?:    ContextRecordSource
      clientId?:  string
      injected?:  boolean
      timestamp?: number
    }

export type ContextSnapshotEvent = {
  userId:        string
  version:       number
  messages:      ApiMessage[]
  recentMessages: ApiMessage[]
  userContext:   string | null
  modeSummaries: Record<string, string>
  toolSummaries: ToolSummary[]
}

export const ContextSnapshotTopic = createTopic<ContextSnapshotEvent>('context.snapshot')

// ─── Per-(user, mode) agent factory options ───

export type AgentFactoryOpts = {
  userId:          string
  clientId:        string
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
  clientId: string
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
  | { type: 'sessionStarted';  userId: string; firstClientId: string; defaultMode: string; timestamp: number }
  | { type: 'sessionEnded';    userId: string; reason: 'lastDisconnect' | 'contextStoreCrash'; timestamp: number }
  | { type: 'modeActivated';   userId: string; mode: string; previousMode: string; source: 'user' | 'llm' | 'programmatic' | 'crashFallback'; timestamp: number }
  | { type: 'clientAttached';  userId: string; clientId: string; clientCount: number; timestamp: number }
  | { type: 'clientDetached';  userId: string; clientId: string; clientCount: number; timestamp: number }

export const SessionLifecycleTopic = createTopic<SessionLifecycleEvent>('session.lifecycle')
