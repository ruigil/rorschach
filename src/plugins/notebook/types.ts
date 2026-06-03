import type { LoopMsg } from '../../system/index.ts'
import type { ToolInvokeMsg } from '../../types/tools.ts'
import type { ActorRef } from '../../system/index.ts'
import type { LlmProviderMsg } from '../../types/llm.ts'

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
}

// ─── Config ───

export type NotebookConfig = {
  notebookDir?:  string  // default: workspace/notebook
  agentModel?:   string
  maxToolLoops?: number  // default: 10
}

// ─── Note agent message protocol ───

export type NoteAgentMsg = LoopMsg | ToolInvokeMsg | { type: '_llmProvider'; ref: ActorRef<LlmProviderMsg> | null }

// ─── Todo reminder message protocol ───

export type TodoReminderMsg =
  | { type: '_scan' }
  | { type: '_tick'; todoId: string; text: string }
