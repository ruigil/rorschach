import type { ActorDef, ActorRef, MessageHandler } from '../../system/types.ts'
import { onLifecycle, onMessage } from '../../system/match.ts'
import { ask } from '../../system/ask.ts'
import type { ToolCollection, ToolEntry, ToolFilter, ToolInvokeMsg, ToolReply, ToolSchema } from '../../types/tools.ts'
import { applyToolFilter, ToolRegistrationTopic } from '../../types/tools.ts'
import type {
  ApiMessage,
  LlmProviderMsg,
  LlmProviderReply,
  Tool,
  ToolCall,
} from '../../types/llm.ts'
import { LlmProviderTopic } from '../../types/llm.ts'
import type { MemoryRecallMsg } from './types.ts'
import { zettelSection } from './ontology.ts'

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
  toolFilter?:   ToolFilter
  maxToolLoops?: number
}

// ─── Internal types ───

type PendingBatch = {
  remaining:          number
  results:            Array<{ toolCallId: string; toolName: string; content: string }>
  messagesAtCall:     ApiMessage[]
  assistantToolCalls: ToolCall[]
}

export type SupervisorState = {
  llmRef:      ActorRef<LlmProviderMsg> | null
  tools:       ToolCollection
  workerIdSeq: number
}

type WorkerState = {
  llmRef:        ActorRef<LlmProviderMsg>
  tools:         ToolCollection
  requestId:     string | null
  turnMessages:  ApiMessage[] | null
  accumulated:   string
  pendingBatch:  PendingBatch | null
  toolLoopCount: number
  replyTo:       ActorRef<ToolReply> | null
  userId:        string
}

// ─── System prompt ───

const buildSystemPrompt = (userId: string): string =>
  `You are a memory retrieval agent for user "${userId}". Answer the query by searching the note network.\n\n` +
  zettelSection(userId) + '\n\n' +
  `## Retrieval Strategy\n\n` +
  `1. **Semantic search** — find relevant notes using:\n` +
  `   zettel_activate { text: "<query rephrased as a topic>", userId: "${userId}" }\n\n` +
  `2. **Read candidates** — for each result returned:\n` +
  `   zettel_read { id: "<id>", userId: "${userId}" }\n\n` +
  `3. **Follow links** — explore notes linked from a candidate note:\n` +
  `   zettel_links { id: "<id>", userId: "${userId}" }\n\n` +
  `4. **Tag search** — if the query is tag-oriented:\n` +
  `   zettel_list { tags: ["<tag>"], userId: "${userId}" }\n\n` +
  `5. **Full-text fallback** — if semantic search returns nothing:\n` +
  `   zettel_search { query: "<keyword>", userId: "${userId}" }\n\n` +
  `Synthesize a concise answer from the note content found. If nothing relevant is found, say so plainly.`

// ─── Worker Actor Definition ───

const createMemoryRecallWorkerActor = (
  options: MemoryRecallOptions,
  parent:  ActorRef<MemoryRecallMsg>,
): ActorDef<MemoryRecallMsg, WorkerState> => {
  const { model, maxToolLoops = 25 } = options

  let awaitingLlmHandler: MessageHandler<MemoryRecallMsg, WorkerState>
  let toolLoopHandler:    MessageHandler<MemoryRecallMsg, WorkerState>

  const finish = (
    state:   WorkerState,
    reply:   ToolReply,
    context: any,
  ): any => {
    state.replyTo!.send(reply)
    parent.send({ type: '_workerDone', worker: context.self as ActorRef<MemoryRecallMsg> })
    return { state }
  }

  // ─── Handler: idle (Worker) ───

  const idleHandler: MessageHandler<MemoryRecallMsg, WorkerState> = onMessage<MemoryRecallMsg, WorkerState>({
    invoke: (state, msg, context) => {
      let query: string
      try {
        const args = JSON.parse(msg.arguments) as { query?: unknown }
        query = typeof args.query === 'string' ? args.query : ''
      } catch {
        msg.replyTo.send({ type: 'toolError', error: 'Invalid arguments' })
        parent.send({ type: '_workerDone', worker: context.self as ActorRef<MemoryRecallMsg> })
        return { state }
      }

      if (!query) {
        msg.replyTo.send({ type: 'toolError', error: 'Missing query argument' })
        parent.send({ type: '_workerDone', worker: context.self as ActorRef<MemoryRecallMsg> })
        return { state }
      }

      const userId    = msg.userId
      const requestId = crypto.randomUUID()
      const messages: ApiMessage[] = [
        { role: 'system', content: buildSystemPrompt(userId) },
        { role: 'user',   content: query },
      ]
      const toolSchemas = Object.values(state.tools).map((e: ToolEntry) => e.schema as Tool)

      state.llmRef.send({
        type:    'stream',
        requestId,
        model,
        messages,
        tools:   toolSchemas.length > 0 ? toolSchemas : undefined,
        role:    'memory-recall',
        replyTo: context.self as unknown as ActorRef<LlmProviderReply>,
      })

      context.log.info('memory recall started', { userId, query: query.slice(0, 120) })

      return {
        state:  { ...state, requestId, turnMessages: messages, accumulated: '', replyTo: msg.replyTo, userId },
        become: awaitingLlmHandler,
      }
    },

    _llmProvider:      (state, msg) => ({ state: { ...state, llmRef: msg.ref ?? state.llmRef } }),
    _toolRegistered:   (state, msg) => ({ state: { ...state, tools: { ...state.tools, [msg.name]: { schema: msg.schema, ref: msg.ref } } } }),
    _toolUnregistered: (state, msg) => { const { [msg.name]: _d, ...rest } = state.tools; return { state: { ...state, tools: rest } } },
  })

  // ─── Handler: awaitingLlm ───

  awaitingLlmHandler = onMessage<MemoryRecallMsg, WorkerState>({
    llmChunk: (state, msg) => {
      if (msg.requestId !== state.requestId) return { state }
      return { state: { ...state, accumulated: state.accumulated + msg.text } }
    },

    llmReasoningChunk: (state) => ({ state }),

    llmToolCalls: (state, msg, context) => {
      if (msg.requestId !== state.requestId) return { state }

      const assistantToolCalls: ToolCall[] = msg.calls.map(c => ({
        id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments },
      }))

      const batch: PendingBatch = {
        remaining:          msg.calls.length,
        results:            [],
        messagesAtCall:     state.turnMessages!,
        assistantToolCalls,
      }

      for (const call of msg.calls) {
        const entry = state.tools[call.name]
        if (!entry) {
          context.log.warn('memory recall: unknown tool', { tool: call.name })
          continue
        }
        context.pipeToSelf(
          ask<ToolInvokeMsg, ToolReply>(
            entry.ref,
            (replyTo) => ({ type: 'invoke', toolName: call.name, arguments: call.arguments, replyTo, userId: state.userId }),
          ),
          (reply) => ({ type: '_toolResult' as const, toolName: call.name, toolCallId: call.id, reply }),
          (error)  => ({
            type:       '_toolResult' as const,
            toolName:   call.name,
            toolCallId: call.id,
            reply:      { type: 'toolError' as const, error: String(error) },
          }),
        )
      }

      return {
        state:  { ...state, requestId: null, pendingBatch: batch },
        become: toolLoopHandler,
      }
    },

    llmDone: (state, msg, context) => {
      if (msg.requestId !== state.requestId) return { state }
      context.log.info('memory recall done', { userId: state.userId })
      return finish(state, { type: 'toolResult', result: state.accumulated || '(no result)' }, context)
    },

    llmError: (state, msg, context) => {
      if (msg.requestId !== state.requestId) return { state }
      context.log.error('memory recall LLM error', { userId: state.userId, error: String(msg.error) })
      return finish(state, { type: 'toolError', error: String(msg.error) }, context)
    },

    _llmProvider:      (state, msg) => ({ state: { ...state, llmRef: msg.ref ?? state.llmRef } }),
    _toolRegistered:   (state, msg) => ({ state: { ...state, tools: { ...state.tools, [msg.name]: { schema: msg.schema, ref: msg.ref } } } }),
    _toolUnregistered: (state, msg) => { const { [msg.name]: _d, ...rest } = state.tools; return { state: { ...state, tools: rest } } },
  })

  // ─── Handler: toolLoop ───

  toolLoopHandler = onMessage<MemoryRecallMsg, WorkerState>({
    _toolResult: (state, msg, context) => {
      const batch   = state.pendingBatch!
      const content = msg.reply.type === 'toolResult' ? msg.reply.result : `Tool error: ${msg.reply.error}`
      const updated = [...batch.results, { toolCallId: msg.toolCallId, toolName: msg.toolName, content }]
      const remaining = batch.remaining - 1

      if (remaining > 0) {
        return { state: { ...state, pendingBatch: { ...batch, remaining, results: updated } } }
      }

      const nextLoopCount = state.toolLoopCount + 1

      if (nextLoopCount >= maxToolLoops) {
        context.log.warn('memory recall tool loop limit reached', { userId: state.userId, limit: maxToolLoops })
        return finish(
          { ...state, pendingBatch: null, toolLoopCount: 0 },
          state.accumulated
            ? { type: 'toolResult', result: state.accumulated }
            : { type: 'toolError',  error:  'Tool loop limit reached' },
          context,
        )
      }

      const toolResultMsgs: ApiMessage[] = updated.map(r => ({
        role: 'tool', content: r.content, tool_call_id: r.toolCallId,
      }))
      const nextMessages: ApiMessage[] = [
        ...batch.messagesAtCall,
        { role: 'assistant', content: null, tool_calls: batch.assistantToolCalls },
        ...toolResultMsgs,
      ]
      const requestId   = crypto.randomUUID()
      const toolSchemas = Object.values(state.tools).map((e: ToolEntry) => e.schema as Tool)

      state.llmRef.send({
        type:    'stream',
        requestId,
        model,
        messages: nextMessages,
        tools:    toolSchemas.length > 0 ? toolSchemas : undefined,
        role:     'memory-recall',
        replyTo:  context.self as unknown as ActorRef<LlmProviderReply>,
      })

      return {
        state:  { ...state, requestId, turnMessages: nextMessages, pendingBatch: null, toolLoopCount: nextLoopCount },
        become: awaitingLlmHandler,
      }
    },

    _llmProvider:      (state, msg) => ({ state: { ...state, llmRef: msg.ref ?? state.llmRef } }),
    _toolRegistered:   (state, msg) => ({ state: { ...state, tools: { ...state.tools, [msg.name]: { schema: msg.schema, ref: msg.ref } } } }),
    _toolUnregistered: (state, msg) => { const { [msg.name]: _d, ...rest } = state.tools; return { state: { ...state, tools: rest } } },
  })

  return {
    handler: idleHandler,
  }
}

// ─── Supervisor Actor Definition ───

export const createMemoryRecallActor = (options: MemoryRecallOptions): ActorDef<MemoryRecallMsg, SupervisorState> => {
  const { toolFilter } = options

  return {
    lifecycle: onLifecycle({
      start: (_state, context) => {
        context.subscribe(LlmProviderTopic, (e) => ({ type: '_llmProvider' as const, ref: e.ref }))
        context.subscribe(ToolRegistrationTopic, (e) => {
          if (!applyToolFilter(e.name, toolFilter)) return null
          if (e.ref === null) {
            return { type: '_toolUnregistered' as const, name: e.name }
          }
          return { type: '_toolRegistered' as const, name: e.name, schema: e.schema, ref: e.ref }
        })
        context.publishRetained(ToolRegistrationTopic, MEMORY_RECALL_TOOL_NAME, {
          name:   MEMORY_RECALL_TOOL_NAME,
          schema: MEMORY_RECALL_SCHEMA,
          ref:    context.self as unknown as ActorRef<ToolInvokeMsg>,
        })
        return { state: _state }
      },

      stopped: (_state, context) => {
        context.deleteRetained(ToolRegistrationTopic, MEMORY_RECALL_TOOL_NAME, {
          name: MEMORY_RECALL_TOOL_NAME,
          ref:  null,
        })
        return { state: _state }
      },
    }),

    handler: onMessage<MemoryRecallMsg, SupervisorState>({
      invoke: (state, msg, context) => {
        if (state.llmRef === null) {
          msg.replyTo.send({ type: 'toolError', error: 'Memory not ready' })
          return { state }
        }

        const nextSeq  = state.workerIdSeq + 1
        const workerId = `memory-recall-worker-${nextSeq}`

        const worker = context.spawn(
          workerId,
          createMemoryRecallWorkerActor(options, context.self as ActorRef<MemoryRecallMsg>),
          {
            llmRef:        state.llmRef,
            tools:         state.tools,
            requestId:     null,
            turnMessages:  null,
            accumulated:   '',
            pendingBatch:  null,
            toolLoopCount: 0,
            replyTo:       null,
            userId:        '',
          },
        )

        worker.send(msg)

        return { state: { ...state, workerIdSeq: nextSeq } }
      },

      _workerDone: (state, msg, context) => {
        context.stop(msg.worker)
        return { state }
      },

      _llmProvider: (state, msg) =>
        ({ state: { ...state, llmRef: msg.ref } }),

      _toolRegistered: (state, msg) =>
        ({ state: { ...state, tools: { ...state.tools, [msg.name]: { schema: msg.schema, ref: msg.ref } } } }),

      _toolUnregistered: (state, msg) => {
        const { [msg.name]: _dropped, ...rest } = state.tools
        return { state: { ...state, tools: rest } }
      },
    }),
  }
}

export const INITIAL_RECALL_STATE: SupervisorState = {
  llmRef:      null,
  tools:       {},
  workerIdSeq: 0,
}
