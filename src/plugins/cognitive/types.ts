import type { ActorRef } from '../../system/types.ts'
import { createTopic } from '../../system/types.ts'
import type { LlmProviderMsg, LlmProviderReply } from '../../types/llm.ts'
import type { ToolInvokeMsg, ToolReply, ToolSchema, ToolFilter } from '../../types/tools.ts'

// ─── Chatbot actor message protocol ───

export type ChatbotMsg =
  | { type: 'userMessage'; clientId: string; text: string; images?: string[]; audio?: string; pdfs?: string[]; traceId: string; parentSpanId: string; isCron?: boolean }
  | LlmProviderReply
  | { type: '_toolRegistered';      name: string; schema: ToolSchema; ref: ActorRef<ToolInvokeMsg> }
  | { type: '_toolUnregistered';    name: string }
  | { type: '_toolResult';          toolName: string; toolCallId: string; reply: ToolReply }
  | { type: '_llmProviderUpdated';  ref: ActorRef<LlmProviderMsg> | null }
  | { type: '_userContext';         summary: string }
  | { type: '_plannerDone' }

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

// ─── Planner input message (subset sent by session-manager) ───

export type PlannerInputMsg = { type: '_userInput'; clientId: string; text: string }

// ─── Planner session routing topic ───

export type PlannerSessionEvent =
  | { clientId: string; plannerRef: ActorRef<PlannerInputMsg> }
  | { clientId: string; plannerRef: null; summary?: string }

/** Retained topic. Planner publishes when a session starts/ends for a clientId.
 *  Session manager subscribes to re-route user messages to the planner while active. */
export const PlannerActiveTopic = createTopic<PlannerSessionEvent>('planner.session.active')
