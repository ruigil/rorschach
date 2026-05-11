import type { ActorDef, ActorRef } from '../../system/types.ts'
import { createReactLoop, initialReactLoopSlice, type ReactLoopSlice } from '../../system/react-loop.ts'
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

export type MemoryRecallWorkerOptions = {
  model:        string
  maxToolLoops: number
  tools:        ToolCollection
  llmRef:       ActorRef<LlmProviderMsg>
}

// ─── Worker State ───

export type MemoryRecallWorkerState = {
  loop: ReactLoopSlice
}

// ─── System prompt ───

const buildSystemPrompt = (userId: string): string =>
  `You are a memory retrieval agent for user "${userId}". Answer the query by searching the note network.\n\n` +
  zettelRecallSection(userId) +
  `Synthesize a concise answer from the note content found. If nothing relevant is found, say so plainly.`

// ─── Worker Actor ───

export const createMemoryRecallWorkerActor = (
  parent:  ActorRef<MemorySupervisorMsg>,
  options: MemoryRecallWorkerOptions,
): ActorDef<MemoryRecallMsg, MemoryRecallWorkerState> => {
  const handlers = createReactLoop<MemoryRecallWorkerState, MemoryRecallMsg>({
    role:            'memory-recall',
    spanName:        'memory-recall',
    logPrefix:       'memory recall',
    stashConcurrent: false,
    model:           options.model,
    maxToolLoops:    options.maxToolLoops,
    tools:           options.tools,

    slice:    (s) => s.loop,
    setSlice: (s, loop) => ({ ...s, loop }),

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
      }
    },

    onComplete: (state, finalText, ctx) => {
      state.loop.turn.replyTo?.send({ type: 'toolResult', result: { text: finalText || '(no result)' } })
      parent.send({ type: '_workerDone', worker: { name: ctx.self.name } })
      return { state }
    },

    onLlmError: (state, error, ctx) => {
      state.loop.turn.replyTo?.send({ type: 'toolError', error: String(error) })
      parent.send({ type: '_workerDone', worker: { name: ctx.self.name } })
      return { state }
    },

    onLoopLimit: (state, finalText, ctx) => {
      const reply: ToolReply = finalText
        ? { type: 'toolResult', result: { text: finalText } }
        : { type: 'toolError',  error:  'Tool loop limit reached' }
      state.loop.turn.replyTo?.send(reply)
      parent.send({ type: '_workerDone', worker: { name: ctx.self.name } })
      return { state }
    },
  })

  return {
    initialState: () => ({ loop: { llmRef: options.llmRef, turn: initialReactLoopSlice().turn } }),
    handler: handlers.idle,
  }
}
