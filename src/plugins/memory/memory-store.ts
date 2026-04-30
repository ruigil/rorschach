import type { ActorDef, ActorRef, MessageHandler, SpanHandle } from '../../system/types.ts'
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
import type { MemoryStoreMsg } from './types.ts'
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
  toolFilter?:   ToolFilter
  maxToolLoops?: number
}

// ─── Internal types ───

type PendingBatch = {
  remaining:          number
  results:            Array<{ toolCallId: string; toolName: string; content: string }>
  messagesAtCall:     ApiMessage[]
  assistantToolCalls: ToolCall[]
  toolSpans:          Record<string, SpanHandle>
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
  requestSpan:   SpanHandle | null
  llmSpan:       SpanHandle | null
}

// ─── System prompt ───

const buildSystemPrompt = (userId: string, topic?: string): string => {
  const topicHint = topic ? `\nThe user suggests this information is related to: "${topic}".` : ''
  return (
    `You are a memory storage agent for user "${userId}". Store the given information as Zettelkasten notes.${topicHint}\n\n` +
    zettelStoreSection(userId) + '\n\n' +
    `## Storage Workflow\n\n` +
    `1. zettel_search { text: "<one-sentence synopsis of what to store>", userId: "${userId}" } — check if a note already covers this topic (returns full content).\n` +
    `2. If a matching note is found → zettel_update it with the merged information.\n` +
    `3. If no matching note exists → zettel_create a new atomic note.\n` +
    `4. After storing the note, use zettel_link to connect it to related notes if relevant:\n` +
    `   zettel_link { sourceName: "Note Title", targetName: "Related Note", userId: "${userId}" }\n` +
    `   Only link to notes confirmed to exist via zettel_search or zettel_read.\n` +
    `5. Return a brief confirmation of what was stored.\n\n` +
    `Only store what was explicitly provided. Do not infer beyond the given content.`
  )
}

// ─── Worker Actor Definition ───

const createMemoryStoreWorkerActor = (
  options: MemoryStoreOptions,
  parent:  ActorRef<MemoryStoreMsg>,
): ActorDef<MemoryStoreMsg, WorkerState> => {
  const { model, maxToolLoops = 25 } = options

  let awaitingLlmHandler: MessageHandler<MemoryStoreMsg, WorkerState>
  let toolLoopHandler:    MessageHandler<MemoryStoreMsg, WorkerState>

  const finish = (
    state: WorkerState,
    reply: ToolReply,
    context: any,
  ): any => { // Using any to simplify ActorResult union matching
    state.replyTo!.send(reply)
    parent.send({ type: '_workerDone', worker: context.self as ActorRef<MemoryStoreMsg> })
    return { state }
  }

  // ─── Handler: idle (Worker) ───

  const idleHandler: MessageHandler<MemoryStoreMsg, WorkerState> = onMessage<MemoryStoreMsg, WorkerState>({
    invoke: (state, msg, context) => {
      const traceParent = context.trace.fromHeaders()
      const requestSpan = traceParent
        ? context.trace.child(traceParent.traceId, traceParent.spanId, 'memory-store', {})
        : null

      let content: string
      let topic: string | undefined
      try {
        const args = JSON.parse(msg.arguments) as { content?: unknown; topic?: unknown }
        content = typeof args.content === 'string' ? args.content : ''
        topic   = typeof args.topic   === 'string' ? args.topic   : undefined
      } catch {
        requestSpan?.error('Invalid arguments')
        msg.replyTo.send({ type: 'toolError', error: 'Invalid arguments' })
        parent.send({ type: '_workerDone', worker: context.self as ActorRef<MemoryStoreMsg> })
        return { state }
      }

      if (!content) {
        requestSpan?.error('Missing content argument')
        msg.replyTo.send({ type: 'toolError', error: 'Missing content argument' })
        parent.send({ type: '_workerDone', worker: context.self as ActorRef<MemoryStoreMsg> })
        return { state }
      }

      const userId    = msg.userId
      const requestId = crypto.randomUUID()
      const messages: ApiMessage[] = [
        { role: 'system', content: buildSystemPrompt(userId, topic) },
        { role: 'user',   content },
      ]
      const toolSchemas = Object.values(state.tools).map((e: ToolEntry) => e.schema as Tool)

      const llmSpan = requestSpan
        ? context.trace.child(requestSpan.traceId, requestSpan.spanId, 'llm-call', { model })
        : null

      state.llmRef.send({
        type:    'stream',
        requestId,
        model,
        messages,
        tools:   toolSchemas.length > 0 ? toolSchemas : undefined,
        role:    'memory-store',
        replyTo: context.self as unknown as ActorRef<LlmProviderReply>,
      })

      context.log.info('memory store worker started', { userId, topic })

      return {
        state: { ...state, requestId, turnMessages: messages, accumulated: '', replyTo: msg.replyTo, userId, requestSpan, llmSpan },
        become: awaitingLlmHandler,
      }
    },
  })

  // ─── Handler: awaitingLlm (Worker) ───

  awaitingLlmHandler = onMessage<MemoryStoreMsg, WorkerState>({
    llmChunk: (state, msg) => {
      if (msg.requestId !== state.requestId) return { state }
      return { state: { ...state, accumulated: state.accumulated + msg.text } }
    },

    llmReasoningChunk: (state) => ({ state }),

    llmToolCalls: (state, msg, context) => {
      if (msg.requestId !== state.requestId) return { state }

      state.llmSpan?.done({ toolCalls: msg.calls.map(c => c.name) })

      const assistantToolCalls: ToolCall[] = msg.calls.map(c => ({
        id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments },
      }))

      const batch: PendingBatch = {
        remaining:          msg.calls.length,
        results:            [],
        messagesAtCall:     state.turnMessages!,
        assistantToolCalls,
        toolSpans:          {},
      }

      for (const call of msg.calls) {
        const entry = state.tools[call.name]
        if (!entry) {
          context.log.warn('memory store worker: unknown tool', { tool: call.name })
          continue
        }
        const toolSpan = state.requestSpan
          ? context.trace.child(
              state.requestSpan.traceId,
              state.requestSpan.spanId,
              'tool-invoke',
              { toolName: call.name },
            )
          : null
        if (toolSpan) {
          batch.toolSpans[call.id] = toolSpan
        }
        context.pipeToSelf(
          ask<ToolInvokeMsg, ToolReply>(
            entry.ref,
            (replyTo) => ({ type: 'invoke', toolName: call.name, arguments: call.arguments, replyTo, userId: state.userId }),
            undefined,
            toolSpan ? context.trace.injectHeaders(toolSpan) : undefined,
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
        state:  { ...state, requestId: null, pendingBatch: batch, llmSpan: null },
        become: toolLoopHandler,
      }
    },

    llmDone: (state, msg, context) => {
      if (msg.requestId !== state.requestId) return { state }
      state.llmSpan?.done()
      state.requestSpan?.done()
      context.log.info('memory store worker done', { userId: state.userId })
      return finish(state, { type: 'toolResult', result: state.accumulated || 'Memory stored.' }, context)
    },

    llmError: (state, msg, context) => {
      if (msg.requestId !== state.requestId) return { state }
      state.llmSpan?.error(String(msg.error))
      state.requestSpan?.error(String(msg.error))
      context.log.error('memory store worker LLM error', { userId: state.userId, error: String(msg.error) })
      return finish(state, { type: 'toolError', error: String(msg.error) }, context)
    },
  })

  // ─── Handler: toolLoop (Worker) ───

  toolLoopHandler = onMessage<MemoryStoreMsg, WorkerState>({
    _toolResult: (state, msg, context) => {
      const batch   = state.pendingBatch!
      const content = msg.reply.type === 'toolResult' ? msg.reply.result : `Tool error: ${msg.reply.error}`
      const updated = [...batch.results, { toolCallId: msg.toolCallId, toolName: msg.toolName, content }]
      const remaining = batch.remaining - 1

      const toolSpan = batch.toolSpans[msg.toolCallId]
      if (toolSpan) {
        msg.reply.type === 'toolResult' ? toolSpan.done() : toolSpan.error(msg.reply.error)
      }

      if (remaining > 0) {
        return { state: { ...state, pendingBatch: { ...batch, remaining, results: updated } } }
      }

      const nextLoopCount = state.toolLoopCount + 1

      if (nextLoopCount >= maxToolLoops) {
        state.requestSpan?.error('tool loop limit reached')
        context.log.warn('memory store worker tool loop limit reached', { userId: state.userId, limit: maxToolLoops })
        return finish(
          { ...state, pendingBatch: null, toolLoopCount: 0, requestSpan: null, llmSpan: null },
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

      const llmSpan = state.requestSpan
        ? context.trace.child(state.requestSpan.traceId, state.requestSpan.spanId, 'llm-call', { model })
        : null

      state.llmRef.send({
        type:    'stream',
        requestId,
        model,
        messages: nextMessages,
        tools:    toolSchemas.length > 0 ? toolSchemas : undefined,
        role:     'memory-store',
        replyTo:  context.self as unknown as ActorRef<LlmProviderReply>,
      })

      return {
        state:  { ...state, requestId, turnMessages: nextMessages, pendingBatch: null, toolLoopCount: nextLoopCount, llmSpan },
        become: awaitingLlmHandler,
      }
    },
  })

  return {
    handler: idleHandler,
  }
}

// ─── Supervisor Actor Definition ───

export const createMemoryStoreActor = (options: MemoryStoreOptions): ActorDef<MemoryStoreMsg, SupervisorState> => {
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
        context.publishRetained(ToolRegistrationTopic, MEMORY_STORE_TOOL_NAME, {
          name:   MEMORY_STORE_TOOL_NAME,
          schema: MEMORY_STORE_SCHEMA,
          ref:    context.self as unknown as ActorRef<ToolInvokeMsg>,
        })
        return { state: _state }
      },

      stopped: (_state, context) => {
        context.deleteRetained(ToolRegistrationTopic, MEMORY_STORE_TOOL_NAME, {
          name: MEMORY_STORE_TOOL_NAME,
          ref:  null,
        })
        return { state: _state }
      },
    }),

    handler: onMessage<MemoryStoreMsg, SupervisorState>({
      invoke: (state, msg, context) => {
        if (state.llmRef === null) {
          msg.replyTo.send({ type: 'toolError', error: 'Memory not ready' })
          return { state }
        }

        const nextSeq  = state.workerIdSeq + 1
        const workerId = `memory-store-worker-${nextSeq}`

        const worker = context.spawn(
          workerId,
          createMemoryStoreWorkerActor(options, context.self as ActorRef<MemoryStoreMsg>),
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
            requestSpan:   null,
            llmSpan:       null,
          },
        )

        worker.send(msg, context.messageHeaders())

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

export const INITIAL_STORE_STATE: SupervisorState = {
  llmRef:      null,
  tools:       {},
  workerIdSeq: 0,
}
