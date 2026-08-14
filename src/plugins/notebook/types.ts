import type { LoopMsg, LoopState, ContextView } from '../../system/index.ts'
import { createTopic } from '../../system/index.ts'
import type { MessageAttachment } from '../../types/events.ts'

// ─── Domain types ───

export type HabitDef = {
  name:         string
  unit:         string
  dailyTarget?: number
}

export type Todo = {
  id:          string
  text:        string
  done:        boolean
  doneAt?:     number
  dueDate?:    string  // YYYY-MM-DD
  recurrence?: string  // cron expression
  createdAt:   number
  priority?:   'low' | 'medium' | 'high'
}

export type { NotebookConfig } from './notebook.config.ts'

import type { ContextSnapshotEvent, AgentModelOptions } from '../../types/agents.ts'

// ─── Coach agent message protocol ───

export type CoachExtraMsg =
  | { type: 'userMessage'; text: string; attachments?: MessageAttachment[]; isInjected?: boolean }
  | ({ type: '_contextSnapshot' } & ContextSnapshotEvent)

export type CoachAgentMsg = LoopMsg<CoachExtraMsg>


export type CoachAgentState = {
  loop:        LoopState
  contextView: ContextView
}

export type NotebookChangeEvent =
  | { type: 'todosUpdated'; userId: string }
  | { type: 'journalUpdated'; userId: string; date: string }
  | { type: 'trackerUpdated'; userId: string; habit: string }

export const NotebookChangeTopic = createTopic<NotebookChangeEvent>('notebook.change')

