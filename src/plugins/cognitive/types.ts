import type { ActorIdentity, ActorRef } from '../../system/types.ts'
import { createTopic } from '../../system/types.ts'
import type { LlmProviderMsg, LlmProviderReply } from '../../types/llm.ts'
import type { ToolFinalReply, ToolInvokeMsg, ToolMsg, ToolSchema, ToolFilter } from '../../types/tools.ts'

// ─── Chatbot actor message protocol ───

export type ChatbotMsg =
  | { type: 'userMessage'; clientId: string; text: string; images?: string[]; audio?: string; pdfs?: string[]; traceId: string; parentSpanId: string; isCron?: boolean; isInjected?: boolean }
  | LlmProviderReply
  | { type: '_toolRegistered';      name: string; schema: ToolSchema; ref: ActorRef<ToolMsg>; mayBeLongRunning?: boolean }
  | { type: '_toolUnregistered';    name: string }
  | { type: '_toolResult';          toolName: string; toolCallId: string; reply: ToolFinalReply }
  | { type: '_toolUpdate';          toolName: string; toolCallId: string; reply: ToolFinalReply }
  | { type: '_llmProvider';         ref: ActorRef<LlmProviderMsg> | null }
  | { type: '_userContext';         summary: string }

// ─── Planner configuration (used to configure per-session planner instances) ───

export type PlannerConfig = {
  model?:        string
  plansDir?:     string
  maxToolLoops?: number
  toolFilter?:   ToolFilter
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

// ─── Planner input message (sent by session-manager) ───

export type PlannerInputMsg = { type: 'userMessage'; clientId: string; text: string }

// ─── Planner session routing topic ───

export type PlannerSessionEvent =
  | { clientId: string; plannerRef: ActorRef<PlannerInputMsg> }
  | { clientId: string; plannerRef: null; summary?: string }

/** Retained topic. Planner publishes when a session starts/ends for a clientId.
 *  Session manager subscribes to re-route user messages to the planner while active. */
export const PlannerActiveTopic = createTopic<PlannerSessionEvent>('planner.session.active')

// ─── Planner supervisor / worker message protocols ───
// Supervisor: receives invoke messages and spawns one worker per planning session.
// Workers send `_workerDone` to the supervisor when their session terminates.

export type PlannerSupervisorMsg =
  | ToolInvokeMsg
  | { type: '_workerDone';      worker: ActorIdentity }
  | { type: '_llmProvider';     ref: ActorRef<LlmProviderMsg> | null }
  | { type: '_toolRegistered';   name: string; schema: ToolSchema; ref: ActorRef<ToolMsg>; mayBeLongRunning?: boolean }
  | { type: '_toolUnregistered'; name: string }

// Worker: one per active planning session, owns the conversational state.

export type PlannerSessionWorkerMsg =
  | PlannerInputMsg
  | LlmProviderReply
  | { type: '_kickoff' }
  | { type: '_toolResult';     toolCallId: string; toolName: string; reply: ToolFinalReply }
  | { type: '_planWriteDone';  filepath: string }
  | { type: '_planWriteError'; error: string }
