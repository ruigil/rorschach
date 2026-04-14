import type { ActorRef, SpanHandle } from '../../system/types.ts'
import type { ToolInvokeMsg, ToolReply, ToolSchema } from '../../types/tools.ts'
import type { LlmProviderMsg, LlmProviderReply } from '../../types/llm.ts'

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
  notebookDir?:             string  // default: workspace/notebook
  agentModel?:              string
  consolidationIntervalMs?: number  // default: 604_800_000 (7 days)
  maxToolLoops?:            number  // default: 10
}

// ─── Shared internal types ───

export type PendingBatch = {
  remaining:          number
  results:            Array<{ toolCallId: string; toolName: string; content: string }>
  messagesAtCall:     import('../../types/llm.ts').ApiMessage[]
  assistantToolCalls: import('../../types/llm.ts').ToolCall[]
  spans:              Record<string, SpanHandle>
}

// ─── Note agent message protocol ───

export type NoteAgentMsg =
  | ToolInvokeMsg
  | LlmProviderReply
  | { type: '_toolResult'; toolCallId: string; toolName: string; reply: ToolReply }
  | { type: '_llmProviderUpdated'; ref: ActorRef<LlmProviderMsg> | null }

// ─── Notebook consolidation message protocol ───

export type NotebookConsolidationMsg =
  | { type: '_consolidate' }
  | { type: '_ready'; requestId: string; messages: import('../../types/llm.ts').ApiMessage[] }
  | { type: '_llmProvider'; ref: ActorRef<LlmProviderMsg> | null }
  | { type: '_toolRegistered'; name: string; schema: ToolSchema; ref: ActorRef<ToolInvokeMsg> }
  | { type: '_toolUnregistered'; name: string }
  | { type: '_toolResult'; toolCallId: string; toolName: string; reply: ToolReply }
  | LlmProviderReply

// ─── Todo reminder message protocol ───

export type TodoReminderMsg =
  | { type: '_scan' }
  | { type: '_tick'; todoId: string; text: string }
