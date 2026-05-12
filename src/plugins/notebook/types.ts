import type { LoopMsg } from '../../system/agent-loop.ts'
import type { ToolInvokeMsg } from '../../types/tools.ts'

// ─── Domain types ───

export type HabitDef = {
  name:         string
  unit:         string
  dailyTarget?: number
}

export type Attachment = {
  id:           string
  originalName: string
  path:         string    // 'inbound/{filename}' — public URL is /{path}
  mimeType:     string
  addedAt:      number
}

export type NoteEntry = {
  id:          string
  title:       string
  tags:        string[]
  createdAt:   number
  updatedAt:   number
  path:        string       // relative to notebookDir: notes/{uuid}.md
  links:       string[]     // [[wiki-link]] targets extracted from content
  attachments: Attachment[]
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

export type NoteAgentMsg = LoopMsg | ToolInvokeMsg

// ─── Todo reminder message protocol ───

export type TodoReminderMsg =
  | { type: '_scan' }
  | { type: '_tick'; todoId: string; text: string }
