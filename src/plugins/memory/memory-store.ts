import type { ActorDef, ActorRef } from '../../system/types.ts'
import { createReactLoop, type ReactTurn } from '../../system/react-loop.ts'
import type { ToolCollection, ToolReply, ToolSchema } from '../../types/tools.ts'
import type { LlmProviderMsg } from '../../types/llm.ts'
import type { MemoryStoreMsg, MemorySupervisorMsg } from './types.ts'
import { zettelStoreSection } from './ontology.ts'

// ─── Tool registration ───

export const MEMORY_STORE_TOOL_NAME = 'store_memory'

export const MEMORY_STORE_SCHEMA: ToolSchema = {
  type: 'function',
  function: {
    name: 'store_memory',
    description:
      'Explicitly store a piece of information about the user into long-term memory. Use when the user shares a fact, preference, goal, or decision they want remembered.',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'The information to store. Be specific and factual.' },
        topic:   { type: 'string', description: 'Optional hint for which knowledge base topic to file this under (e.g. "preferences", "projects", "goals").' },
      },
      required: ['content'],
    },
  },
}

// ─── Options ───

export type MemoryStoreOptions = {
  model:         string
  maxToolLoops?: number
}

// ─── Worker State ───

export type MemoryStoreWorkerState = {
  llmRef:       ActorRef<LlmProviderMsg>
  tools:        ToolCollection
  model:        string
  maxToolLoops: number
  replyTo:      ActorRef<ToolReply> | null
  userId:       string
  turn:         ReactTurn
}

// ─── System prompt ───

const buildSystemPrompt = (userId: string, topic?: string): string => {
  const topicHint = topic ? `\nThe user suggests this information is related to: "${topic}".` : ''
  return (
    `You are a memory storage agent for user "${userId}". Store the given information as Zettelkasten notes.${topicHint}\n\n` +
    zettelStoreSection(userId) +
    `Return a brief confirmation of what was stored.`
  )
}

// ─── Worker Actor ───

export const createMemoryStoreWorkerActor = (
  parent: ActorRef<MemorySupervisorMsg>,
): ActorDef<MemoryStoreMsg, MemoryStoreWorkerState> => {
  const handlers = createReactLoop<MemoryStoreWorkerState, MemoryStoreMsg>({
    role:      'memory-store',
    spanName:  'memory-store',
    logPrefix: 'memory store worker',
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
      let content: string
      let topic: string | undefined
      try {
        const args = JSON.parse(msg.arguments) as { content?: unknown; topic?: unknown }
        content = typeof args.content === 'string' ? args.content : ''
        topic   = typeof args.topic   === 'string' ? args.topic   : undefined
      } catch {
        return { error: 'Invalid arguments' }
      }
      if (!content) return { error: 'Missing content argument' }
      return {
        messages: [
          { role: 'system', content: buildSystemPrompt(msg.userId, topic) },
          { role: 'user',   content },
        ],
        updates: (s) => ({ ...s, replyTo: msg.replyTo, userId: msg.userId }),
      }
    },

    onComplete: (state, finalText, ctx) => {
      state.replyTo?.send({ type: 'toolResult', result: finalText || 'Memory stored.' })
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
