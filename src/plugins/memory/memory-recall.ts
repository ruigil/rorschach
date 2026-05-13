import type { ActorDef, ActorContext, ActorRef, ActorResult, Interceptor } from '../../system/types.ts'
import { AgentLoop, type AgentLoopHandle } from '../../system/agent-loop.ts'
import type { ToolCollection, ToolReply, ToolSchema } from '../../types/tools.ts'
import { parseToolArgs } from '../../types/tools.ts'
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
  replyTo: ActorRef<ToolReply> | null
  llmRef:  ActorRef<LlmProviderMsg> | null
}

// ─── System prompt ───

const buildSystemPrompt = (userId: string): string =>
  `You are a memory retrieval agent for user "${userId}". Answer the query by searching the note network.\n\n` +
  zettelRecallSection(userId) +
  `Synthesize a concise answer from the note content found. If nothing relevant is found, say so plainly.`

// ─── Worker Actor ───

export const createMemoryRecallWorkerActor = (parent:  ActorRef<MemorySupervisorMsg>, options: MemoryRecallWorkerOptions): ActorDef<MemoryRecallMsg, MemoryRecallWorkerState> => {

  const handleInvoke = (state: MemoryRecallWorkerState, msg: Extract<MemoryRecallMsg, { type: 'invoke' }>, ctx: ActorContext<MemoryRecallMsg>): ActorResult<MemoryRecallMsg, MemoryRecallWorkerState> => {
    const parsed = parseToolArgs<{ query: string }>(msg.arguments, (p) => {
      const query = typeof p.query === 'string' ? p.query : ''
      return query ? { query } : null
    },'Missing query argument')

    if (!parsed.ok) {
      msg.replyTo.send({ type: 'toolError', error: parsed.error })
      return { state }
    }

    return loop.startTurn(
      { ...state, replyTo: msg.replyTo },
      {
        messages: [
          { role: 'system', content: buildSystemPrompt(msg.userId) },
          { role: 'user',   content: parsed.value.query },
        ],
        userId:   msg.userId,
        clientId: msg.clientId,
      },
      ctx,
    )
  }

  const loop = AgentLoop<MemoryRecallWorkerState, MemoryRecallMsg>({
    role:            'memory-recall',
    spanName:        'memory-recall',
    logPrefix:       'memory recall',
    model:           options.model,
    maxToolLoops:    options.maxToolLoops,
    llmRef:          (s) => s.llmRef,
    tools:           options.tools,

    onComplete: (state, finalText, _, ctx) => {
      state.replyTo?.send({ type: 'toolResult', result: { text: finalText || '(no result)' } })
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
  })

  const hostInterceptor: Interceptor<MemoryRecallMsg, MemoryRecallWorkerState> = (state, msg, ctx, next) => {
    const m = msg as MemoryRecallMsg

    if (m.type === 'invoke') {
      if (loop.phase !== 'idle') return { state, stash: true }
      return handleInvoke(state, m as Extract<MemoryRecallMsg, { type: 'invoke' }>, ctx)
    }

    if (m.type === '_llmProvider') {
      return { state: { ...state, llmRef: m.ref } }
    }

    return next(state, msg)
  }

  return {
    initialState: () => ({ replyTo: null, llmRef: options.llmRef }),
    handler:      loop.idle,
    interceptors: [hostInterceptor],
  }
}
