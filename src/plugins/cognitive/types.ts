import type { ActorDef, ActorRef } from '../../system/types.ts'
import { createTopic } from '../../system/types.ts'
import type { ApiMessage, LlmProviderMsg, LlmProviderReply } from '../../types/llm.ts'
import type { ToolFinalReply, ToolMsg, ToolSchema, ToolFilter } from '../../types/tools.ts'
import type { HistoryStoreMsg } from './history-store.ts'

// ─── Chatbot actor message protocol ───

export type ChatbotMsg =
  | { type: 'userMessage'; clientId: string; text: string; images?: string[]; audio?: string; pdfs?: string[]; traceId: string; parentSpanId: string; isCron?: boolean; isInjected?: boolean }
  | LlmProviderReply
  | { type: '_toolRegistered';      name: string; schema: ToolSchema; ref: ActorRef<ToolMsg>; mayBeLongRunning?: boolean }
  | { type: '_toolUnregistered';    name: string }
  | { type: '_toolResult';          toolName: string; toolCallId: string; reply: ToolFinalReply }
  | { type: '_toolUpdate';          toolName: string; toolCallId: string; reply: ToolFinalReply }
  | { type: '_llmProvider';         ref: ActorRef<LlmProviderMsg> | null }
  | { type: '_historySnapshot';     messages: ApiMessage[]; userContext: string | null; version: number }

// ─── Planner configuration (used to configure per-session planner instances) ───

export type PlannerConfig = {
  model?:        string
  plansDir?:     string
  maxToolLoops?: number
  toolFilter?:   ToolFilter
}

// ─── Session configuration (consumed by SessionManager) ───

export type SessionConfig = {
  defaultMode?:        string   // mode for first-connect, cron routing, crash fallback. Defaults to 'chatbot'.
  historyWindowHours?: number   // trim HistoryStore records older than this on every append.
}

// ─── Plan domain types ───

export type PlanTask = {
  id:                 string
  name:               string
  description:        string
  validationCriteria: string
  dependencies:       string[]
}

export type Plan = {
  id:        string
  goal:      string
  context:   string
  createdAt: string
  tasks:     PlanTask[]
}

// ─── Per-(user, mode) agent factory options ──────────────────────────────────
//
// The descriptor's `factory` is created at agent-registration time — agent-
// specific config (model, prompt, tool filter, …) is closed over there. At
// spawn time, SessionManager hands the factory the per-instance refs.
//
export type AgentFactoryOpts = {
  userId:          string
  clientId:        string
  llmRef:          ActorRef<LlmProviderMsg>
  historyStoreRef: ActorRef<HistoryStoreMsg>
}

// ─── Agent descriptor ────────────────────────────────────────────────────────

export type AgentDescriptor = {
  mode:         string                                       // 'chatbot' | 'planner' | …
  displayName:  string
  shortDesc:    string                                       // used in the switchMode enum
  factory:      (opts: AgentFactoryOpts) => ActorDef<any, any>
  capabilities: { userVisible: boolean }
}

// ─── AgentRegistrationTopic ──────────────────────────────────────────────────
//
// Plugins publish to register/unregister agents. Mirrors ToolRegistrationTopic shape.
//
export type AgentRegistrationEvent =
  | { type: 'register';   descriptor: AgentDescriptor }
  | { type: 'unregister'; mode:       string }

export const AgentRegistrationTopic = createTopic<AgentRegistrationEvent>('agent.registration')

// ─── SwitchAgentTopic ────────────────────────────────────────────────────────
//
// The single switch event consumed by SessionManager. clientId is the
// originator; SessionManager resolves to userId via clientIndex. activeMode is
// keyed by userId (one mode per user across all their clients).
//
export type SwitchAgentEvent = {
  clientId: string
  mode:     string
  source:   'user' | 'llm' | 'programmatic'
  reason?:  string
}

export const SwitchAgentTopic = createTopic<SwitchAgentEvent>('agent.switch')

// ─── AgentCatalogTopic (retained) ────────────────────────────────────────────
//
// Snapshot of registered agents for UI discovery. Republished by the registry
// on every register/unregister. HTTP plugin mirrors locally and pushes a
// welcome frame to clients.
//
export type AgentCatalogEvent = {
  agents: Array<{ mode: string; displayName: string; shortDesc: string }>
}

export const AgentCatalogTopic = createTopic<AgentCatalogEvent>('agent.catalog')

// ─── HistorySnapshotTopic (retained, keyed by userId) ────────────────────────
//
// Single source of truth for shared conversation state. Subscribers filter by
// userId in their adapter. messages is in store-stripped form (no timestamps).
//
export type HistorySnapshotEvent = {
  userId:      string
  messages:    ApiMessage[]
  userContext: string | null
  version:     number
}

export const HistorySnapshotTopic = createTopic<HistorySnapshotEvent>('history.snapshot')

// ─── SessionLifecycleTopic ───────────────────────────────────────────────────
//
// Ephemeral stream of session state transitions, published by SessionManager
// on every meaningful lifecycle edge. Consumers (cron dispatcher, persistence
// flushers, presence, analytics) subscribe to react without coupling to
// SessionManager or re-implementing connection refcounting.
//
export type SessionLifecycleEvent =
  | { type: 'sessionStarted';  userId: string; firstClientId: string; defaultMode: string; timestamp: number }
  | { type: 'sessionEnded';    userId: string; reason: 'lastDisconnect' | 'historyStoreCrash'; timestamp: number }
  | { type: 'modeActivated';   userId: string; mode: string; previousMode: string; source: 'user' | 'llm' | 'programmatic' | 'crashFallback'; timestamp: number }
  | { type: 'clientAttached';  userId: string; clientId: string; clientCount: number; timestamp: number }
  | { type: 'clientDetached';  userId: string; clientId: string; clientCount: number; timestamp: number }

export const SessionLifecycleTopic = createTopic<SessionLifecycleEvent>('session.lifecycle')
