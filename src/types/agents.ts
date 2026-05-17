import type { ActorDef, ActorRef } from '../system/types.ts'
import { createTopic } from '../system/types.ts'
import type { ApiMessage, LlmProviderMsg } from './llm.ts'

// ─── Shared history protocol for session-hosted agents ───

export type AgentHistoryMsg =
  | { type: 'append'; messages: ApiMessage[] }

export type HistorySnapshotEvent = {
  userId:      string
  messages:    ApiMessage[]
  userContext: string | null
  version:     number
}

export const HistorySnapshotTopic = createTopic<HistorySnapshotEvent>('history.snapshot')

// ─── Per-(user, mode) agent factory options ───

export type AgentFactoryOpts = {
  userId:          string
  clientId:        string
  llmRef:          ActorRef<LlmProviderMsg>
  historyStoreRef: ActorRef<AgentHistoryMsg>
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
  | { type: 'sessionEnded';    userId: string; reason: 'lastDisconnect' | 'historyStoreCrash'; timestamp: number }
  | { type: 'modeActivated';   userId: string; mode: string; previousMode: string; source: 'user' | 'llm' | 'programmatic' | 'crashFallback'; timestamp: number }
  | { type: 'clientAttached';  userId: string; clientId: string; clientCount: number; timestamp: number }
  | { type: 'clientDetached';  userId: string; clientId: string; clientCount: number; timestamp: number }

export const SessionLifecycleTopic = createTopic<SessionLifecycleEvent>('session.lifecycle')
