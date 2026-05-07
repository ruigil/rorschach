import type { ActorDef, ActorRef } from '../../system/types.ts'
import { createReactLoop, type ReactTurn } from '../../system/react-loop.ts'
import type { ToolCollection, ToolReply, ToolSchema } from '../../types/tools.ts'
import type { LlmProviderMsg } from '../../types/llm.ts'
import type { MemoryRecallMsg, MemorySupervisorMsg } from './types.ts'
import { zettelRecallSection } from './ontology.ts'

// ─── Tool registration ───

export const MEMORY_RECALL_TOOL_NAME = 'recall_memory'

export const MEMORY_RECALL_SCHEMA: ToolSchema = {
  type: 'function',
  function: {
    name: 'recall_memory',
    description:
      'Retrieve relevant memories from past conversations. Use when the user references something you no longer have in context — past decisions, preferences, projects, or events.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to look up. Be specific.' },
      },
      required: ['query'],
    },
  },
}

// ─── Options ───

export type MemoryRecallOptions = {
  model:         string
  maxToolLoops?: number
}

// ─── Worker State ───

export type MemoryRecallWorkerState = {
  llmRef:       ActorRef<LlmProviderMsg>
  tools:        ToolCollection
  model:        string
  maxToolLoops: number
  replyTo:      ActorRef<ToolReply> | null
  userId:       string
  turn:         ReactTurn
}

// ─── System prompt ───

const buildSystemPrompt = (userId: string): string =>
  `You are a memory retrieval agent for user "${userId}". Answer the query by searching the note network.\n\n` +
  zettelRecallSection(userId) +
  `Synthesize a concise answer from the note content found. If nothing relevant is found, say so plainly.`

// ─── Worker Actor ───

export const createMemoryRecallWorkerActor = (
  parent: ActorRef<MemorySupervisorMsg>,
): ActorDef<MemoryRecallMsg, MemoryRecallWorkerState> => {
  const handlers = createReactLoop<MemoryRecallWorkerState, MemoryRecallMsg>({
    role:      'memory-recall',
    spanName:  'memory-recall',
    logPrefix: 'memory recall',
    stashConcurrent: false,

    llmRef:       (s) => s.llmRef,
    setLlmRef:    (s, ref) => ({ ...s, llmRef: ref ?? s.llmRef }),
    tools:        (s) => s.tools,
    model:        (s) => s.model,
    maxToolLoops: (s) => s.maxToolLoops,
    turn:         (s) => s.turn,
    withTurn:     (s, turn) => ({ ...s, turn }),
    userId:       (s) => s.userId,

    buildTurn: (_s, msg) => {
      let query: string
      try {
        const args = JSON.parse(msg.arguments) as { query?: unknown }
        query = typeof args.query === 'string' ? args.query : ''
      } catch {
        return { error: 'Invalid arguments' }
      }
      if (!query) return { error: 'Missing query argument' }
      return {
        messages: [
          { role: 'system', content: buildSystemPrompt(msg.userId) },
          { role: 'user',   content: query },
        ],
        updates: (s) => ({ ...s, replyTo: msg.replyTo, userId: msg.userId }),
      }
    },

    onComplete: (state, finalText, ctx) => {
      state.replyTo?.send({ type: 'toolResult', result: finalText || '(no result)' })
      parent.send({ type: '_workerDone', worker: { name: ctx.self.name } })
      return { state }
    },

    onLlmError: (state, error, ctx) => {
      state.replyTo?.send({ type: 'toolError', error: String(error) })
      parent.send({ type: '_workerDone', worker: { name: ctx.self.name } })
      return { state }
    },

    onLoopLimit: (state, finalText, ctx) => {
      const reply: ToolReply = finalText
        ? { type: 'toolResult', result: finalText }
        : { type: 'toolError',  error:  'Tool loop limit reached' }
      state.replyTo?.send(reply)
      parent.send({ type: '_workerDone', worker: { name: ctx.self.name } })
      return { state }
    },

    onUnknownTool: () => ({ kind: 'skip' }),
  })

  return {
    handler: handlers.idle,
  }
}
