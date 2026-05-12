import type { ActorDef, ActorContext, ActorRef, ActorResult } from '../../system/types.ts'
import { AgentLoop, initialAgentLoopSlice, type AgentLoopSlice, type AgentLoopPhases, type AgentLoopTriggers } from '../../system/agent-loop.ts'
import type { ToolCollection, ToolReply, ToolSchema } from '../../types/tools.ts'
import { parseToolArgs } from '../../types/tools.ts'
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

export type MemoryStoreWorkerOptions = {
  model:        string
  maxToolLoops: number
  tools:        ToolCollection
  llmRef:       ActorRef<LlmProviderMsg>
}

// ─── Worker State ───

export type MemoryStoreWorkerState = {
  loop:    AgentLoopSlice
  replyTo: ActorRef<ToolReply> | null
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
  parent:  ActorRef<MemorySupervisorMsg>,
  options: MemoryStoreWorkerOptions,
): ActorDef<MemoryStoreMsg, MemoryStoreWorkerState> => {
  let loop: { phases: AgentLoopPhases<MemoryStoreMsg, MemoryStoreWorkerState>; triggers: AgentLoopTriggers<MemoryStoreMsg, MemoryStoreWorkerState> }

  const handleInvoke = (state: MemoryStoreWorkerState, msg: Extract<MemoryStoreMsg, { type: 'invoke' }>, ctx: ActorContext<MemoryStoreMsg>): ActorResult<MemoryStoreMsg, MemoryStoreWorkerState> => {
    const parsed = parseToolArgs<{ content: string; topic?: string }>(
      msg.arguments,
      (p) => {
        const content = typeof p.content === 'string' ? p.content : ''
        const topic = typeof p.topic === 'string' ? p.topic : undefined
        return content ? { content, topic } : null
      },
      'Missing content argument',
    )
    if (!parsed.ok) {
      msg.replyTo.send({ type: 'toolError', error: parsed.error })
      return { state }
    }
    if (!state.loop.llmRef) {
      msg.replyTo.send({ type: 'toolError', error: 'Memory store not ready (no LLM provider).' })
      return { state }
    }
    return loop.triggers.startTurn(
      { ...state, replyTo: msg.replyTo },
      {
        messages: [
          { role: 'system', content: buildSystemPrompt(msg.userId, parsed.value.topic) },
          { role: 'user',   content: parsed.value.content },
        ],
        userId:   msg.userId,
        clientId: msg.clientId,
      },
      ctx,
    )
  }

  loop = AgentLoop<MemoryStoreWorkerState, MemoryStoreMsg>({
    role:            'memory-store',
    spanName:        'memory-store',
    logPrefix:       'memory store worker',
    stashConcurrent: false,
    model:           options.model,
    maxToolLoops:    options.maxToolLoops,
    tools:           options.tools,

    onComplete: (state, finalText, ctx) => {
      state.replyTo?.send({ type: 'toolResult', result: { text: finalText || 'Memory stored.' } })
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
        ? { type: 'toolResult', result: { text: finalText } }
        : { type: 'toolError',  error:  'Tool loop limit reached' }
      state.replyTo?.send(reply)
      parent.send({ type: '_workerDone', worker: { name: ctx.self.name } })
      return { state }
    },

    extraCases: {
      idle: {
        invoke: handleInvoke,
      },
    },
  })

  return {
    initialState: () => ({ loop: { llmRef: options.llmRef, turn: initialAgentLoopSlice().turn }, replyTo: null }),
    handler: loop.phases.idle,
  }
}
