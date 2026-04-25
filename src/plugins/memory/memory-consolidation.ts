import type { ActorContext, ActorDef, ActorRef, ActorResult, MessageHandler } from '../../system/types.ts'
import { onLifecycle, onMessage } from '../../system/match.ts'
import { UserStreamTopic } from '../../types/events.ts'
import type { UserStreamEvent } from '../../types/events.ts'
import type { ToolCollection, ToolEntry, ToolFilter, ToolInvokeMsg, ToolReply } from '../../types/tools.ts'
import { applyToolFilter, ToolRegistrationTopic } from '../../types/tools.ts'
import type {
  ApiMessage,
  LlmProviderMsg,
  LlmProviderReply,
  Tool,
  ToolCall,
} from '../../types/llm.ts'
import { LlmProviderTopic } from '../../types/llm.ts'
import type { MemoryConsolidationMsg, UserConsolidationWorkerMsg, UserContextMsg } from './types.ts'
import { createUserContextActor, INITIAL_USER_CONTEXT_STATE } from './user-context.ts'
import { ask } from '../../system/ask.ts'
import { zettelSection } from './ontology.ts'

// ─── Options ───

export type MemoryConsolidationOptions = {
  model:         string
  intervalMs:    number
  toolFilter?:   ToolFilter
  maxToolLoops?: number
}

type WorkerOptions = {
  model:         string
  userId:        string
  llmRef:        ActorRef<LlmProviderMsg>
  tools:         ToolCollection
  maxToolLoops?: number
}

// ─── Internal types ───

type PendingBatch = {
  remaining:          number
  results:            Array<{ toolCallId: string; toolName: string; content: string }>
  messagesAtCall:     ApiMessage[]
  assistantToolCalls: ToolCall[]
}

type WorkerState = {
  buffer:         UserStreamEvent[]
  requestId:      string | null
  turnMessages:   ApiMessage[] | null
  accumulated:    string
  pendingBatch:   PendingBatch | null
  toolLoopCount:  number
  userContextRef: ActorRef<UserContextMsg> | null
}

const INITIAL_WORKER_STATE: WorkerState = {
  buffer:         [],
  requestId:      null,
  turnMessages:   null,
  accumulated:    '',
  pendingBatch:   null,
  toolLoopCount:  0,
  userContextRef: null,
}

// ─── System prompt ───

const buildSystemPrompt = (userId: string): string =>
  `You are a user model agent for user "${userId}".\n\n` +

  `## Primary Goal\n` +
  `Build a network of atomic notes about this user. Each note captures one self-contained unit of knowledge.\n\n` +

  zettelSection(userId) + '\n\n' +

  `## Consolidation Workflow\n\n` +
  `For each conversation turn, identify 1-3 key topics, then for each topic:\n\n` +

  `1. **Activate** — find semantically similar notes:\n` +
  `   zettel_activate { text: "<topic summary>", userId: "${userId}" }\n\n` +

  `2. **Read** — for each candidate returned, read the full note:\n` +
  `   zettel_read { id: "<id>", userId: "${userId}" }\n\n` +

  `3. **Update or Create**:\n` +
  `   - If an existing note covers this topic → update it with new information:\n` +
  `     zettel_update { id: "<id>", content: "<merged content>", synopsis: "<updated synopsis>", userId: "${userId}" }\n` +
  `   - If no relevant note exists → create a new atomic note:\n` +
  `     zettel_create { name: "<title>", synopsis: "<one sentence>", content: "<content>", tags: ["<tag>"], userId: "${userId}" }\n` +
  `   Repeat steps 1–3 for all topics. Create ALL notes before creating any links.\n\n` +

  `4. **Link** — after ALL notes have been created or updated, use zettel_link to connect related notes:\n` +
  `   zettel_link { sourceName: "Note A", targetName: "Note B", userId: "${userId}" }\n` +
  `   Only call zettel_link after both notes are confirmed to exist.\n\n` +

  `5. **Episodic log** — append a brief entry for notable events or decisions:\n` +
  `   Use bash: cat >> /workspace/memory/${userId}/episodic/YYYY-MM-DD.md << 'EOF'\n` +
  `   ## HH:MM — Short title\n` +
  `   Entry text.\n` +
  `   EOF\n\n` +

  `Skip trivial exchanges (small talk, simple factual questions with no personal signal).\n` +
  `Do not duplicate facts — update the canonical note instead of creating a new one.`

const buildMessages = (userId: string, turns: UserStreamEvent[]): ApiMessage[] => {
  const turnList = turns.map((t, i) => {
    const date = new Date(t.timestamp).toISOString()
    return `Turn ${i + 1} [${date}]\nUser: ${t.userText}\nAssistant: ${t.assistantText}`
  }).join('\n\n')
  return [
    { role: 'system', content: buildSystemPrompt(userId) },
    { role: 'user', content: `Please consolidate these conversation turns into memory:\n\n${turnList}` },
  ]
}

// ─── Worker actor: one per user, persistent, owns its UserContext child ───

const createUserConsolidationWorker = (options: WorkerOptions): ActorDef<UserConsolidationWorkerMsg, WorkerState> => {
  const { model, userId, llmRef, tools, maxToolLoops = 25 } = options

  type Ctx = ActorContext<UserConsolidationWorkerMsg>
  type Result = ActorResult<UserConsolidationWorkerMsg, WorkerState>

  let awaitingLlmHandler: MessageHandler<UserConsolidationWorkerMsg, WorkerState>
  let toolLoopHandler:    MessageHandler<UserConsolidationWorkerMsg, WorkerState>

  const bufferTurn = (state: WorkerState, msg: Extract<UserConsolidationWorkerMsg, { type: '_turn' }>): { state: WorkerState } => ({
    state: {
      ...state,
      buffer: [
        ...state.buffer,
        { userId, userText: msg.userText, assistantText: msg.assistantText, timestamp: msg.timestamp },
      ],
    },
  })

  const startConsolidation = (state: WorkerState, context: Ctx): Result => {
    if (state.buffer.length === 0) return { state }

    const snapshotTurns = state.buffer
    const requestId     = crypto.randomUUID()
    const messages      = buildMessages(userId, snapshotTurns)
    const toolSchemas   = Object.values(tools).map((e: ToolEntry) => e.schema as Tool)

    llmRef.send({
      type: 'stream',
      requestId,
      model,
      messages,
      tools: toolSchemas.length > 0 ? toolSchemas : undefined,
      role: 'memory-consolidation',
      replyTo: context.self as unknown as ActorRef<LlmProviderReply>,
    })

    context.log.info('memory consolidation started', { userId, turns: snapshotTurns.length })

    return {
      state: {
        ...state,
        buffer:        [],
        requestId,
        turnMessages:  messages,
        accumulated:   '',
        pendingBatch:  null,
        toolLoopCount: 0,
      },
      become: awaitingLlmHandler,
    }
  }

  // ─── Handler: idle ───

  const idleHandler: MessageHandler<UserConsolidationWorkerMsg, WorkerState> = onMessage<UserConsolidationWorkerMsg, WorkerState>({
    _turn:        bufferTurn,
    _consolidate: (state, _, context) => startConsolidation(state, context),
  })

  // ─── Handler: awaitingLlm ───

  awaitingLlmHandler = onMessage<UserConsolidationWorkerMsg, WorkerState>({
    _turn:        bufferTurn,
    _consolidate: (state) => ({ state }),

    llmChunk: (state, msg) => {
      if (msg.requestId !== state.requestId) return { state }
      return { state: { ...state, accumulated: state.accumulated + msg.text } }
    },

    llmReasoningChunk: (state) => ({ state }),

    llmToolCalls: (state, msg, context) => {
      if (msg.requestId !== state.requestId) return { state }

      const { calls } = msg

      const assistantToolCalls: ToolCall[] = calls.map(c => ({
        id: c.id,
        type: 'function',
        function: { name: c.name, arguments: c.arguments },
      }))

      const batch: PendingBatch = {
        remaining: calls.length,
        results: [],
        messagesAtCall: state.turnMessages!,
        assistantToolCalls,
      }

      for (const call of calls) {
        const entry = tools[call.name]
        if (!entry) {
          context.log.warn('memory consolidation: unknown tool', { tool: call.name })
          continue
        }
        context.pipeToSelf(
          ask<ToolInvokeMsg, ToolReply>(
            entry.ref,
            (replyTo) => ({ type: 'invoke', toolName: call.name, arguments: call.arguments, replyTo, userId }),
          ),
          (reply) => ({ type: '_toolResult' as const, toolName: call.name, toolCallId: call.id, reply }),
          (error) => ({
            type: '_toolResult' as const,
            toolName: call.name,
            toolCallId: call.id,
            reply: { type: 'toolError' as const, error: String(error) },
          }),
        )
      }

      return {
        state: { ...state, requestId: null, pendingBatch: batch },
        become: toolLoopHandler,
      }
    },

    llmDone: (state, msg, context): Result => {
      if (msg.requestId !== state.requestId) return { state }
      context.log.info('memory consolidation done', { userId })

      let ucRef = state.userContextRef
      if (!ucRef) {
        const userContextTools = Object.fromEntries(
          Object.entries(tools).filter(([n]) => n === 'read' || n.startsWith('zettel_')),
        ) as ToolCollection
        ucRef = context.spawn(
          'user-context',
          createUserContextActor({ model, userId, llmRef, tools: userContextTools }),
          INITIAL_USER_CONTEXT_STATE,
        )
      }
      ucRef.send({ type: '_run' })

      return {
        state:  { ...state, requestId: null, turnMessages: null, accumulated: '', userContextRef: ucRef },
        become: idleHandler,
      }
    },

    llmError: (state, msg, context) => {
      if (msg.requestId !== state.requestId) return { state }
      context.log.error('memory consolidation LLM error', { userId, error: String(msg.error) })
      return {
        state:  { ...state, requestId: null, turnMessages: null, accumulated: '' },
        become: idleHandler,
      }
    },
  })

  // ─── Handler: toolLoop ───

  toolLoopHandler = onMessage<UserConsolidationWorkerMsg, WorkerState>({
    _turn:        bufferTurn,
    _consolidate: (state) => ({ state }),

    _toolResult: (state, msg, context) => {
      const batch          = state.pendingBatch!
      const content        = msg.reply.type === 'toolResult' ? msg.reply.result : `Tool error: ${msg.reply.error}`
      const updatedResults = [...batch.results, { toolCallId: msg.toolCallId, toolName: msg.toolName, content }]
      const remaining      = batch.remaining - 1

      if (remaining > 0) {
        return { state: { ...state, pendingBatch: { ...batch, remaining, results: updatedResults } } }
      }

      const nextLoopCount = state.toolLoopCount + 1

      if (nextLoopCount >= maxToolLoops) {
        context.log.warn('memory consolidation tool loop limit reached', { userId, limit: maxToolLoops })
        return {
          state:  { ...state, requestId: null, turnMessages: null, accumulated: '', pendingBatch: null, toolLoopCount: 0 },
          become: idleHandler,
        }
      }

      const toolResultMsgs: ApiMessage[] = updatedResults.map(r => ({
        role: 'tool', content: r.content, tool_call_id: r.toolCallId,
      }))
      const nextMessages: ApiMessage[] = [
        ...batch.messagesAtCall,
        { role: 'assistant', content: null, tool_calls: batch.assistantToolCalls },
        ...toolResultMsgs,
      ]

      context.log.debug(JSON.stringify(toolResultMsgs))

      const requestId   = crypto.randomUUID()
      const toolSchemas = Object.values(tools).map((e: ToolEntry) => e.schema as Tool)

      llmRef.send({
        type: 'stream',
        requestId,
        model,
        messages: nextMessages,
        tools: toolSchemas.length > 0 ? toolSchemas : undefined,
        role: 'memory-consolidation',
        replyTo: context.self as unknown as ActorRef<LlmProviderReply>,
      })

      return {
        state:  { ...state, requestId, turnMessages: nextMessages, pendingBatch: null, toolLoopCount: nextLoopCount },
        become: awaitingLlmHandler,
      }
    },
  })

  return {
    handler: idleHandler,
  }
}

// ─── Supervisor actor: routes turns to per-user workers ───

export type ConsolidationState = {
  llmRef:    ActorRef<LlmProviderMsg> | null
  tools:     ToolCollection
  workers:   Record<string, ActorRef<UserConsolidationWorkerMsg>>
  workerSeq: number
}

export const createMemoryConsolidationActor = (options: MemoryConsolidationOptions): ActorDef<MemoryConsolidationMsg, ConsolidationState> => {
  const { model, intervalMs, toolFilter, maxToolLoops } = options

  const stopAllWorkers = (
    state:   ConsolidationState,
    context: ActorContext<MemoryConsolidationMsg>,
  ): ConsolidationState => {
    for (const ref of Object.values(state.workers)) context.stop(ref)
    return { ...state, workers: {} }
  }

  return {
    lifecycle: onLifecycle({
      start: (state, context) => {
        context.subscribe(UserStreamTopic, (e) => ({
          type: '_turn' as const,
          userId: e.userId,
          userText: e.userText,
          assistantText: e.assistantText,
          timestamp: e.timestamp,
        }))
        context.subscribe(LlmProviderTopic, (e) => ({
          type: '_llmProvider' as const,
          ref: e.ref,
        }))
        context.subscribe(ToolRegistrationTopic, (e) => {
          if (!applyToolFilter(e.name, toolFilter)) return null
          return e.ref === null
            ? { type: '_toolUnregistered' as const, name: e.name }
            : { type: '_toolRegistered' as const, name: e.name, schema: e.schema, ref: e.ref }
        })
        context.timers.startPeriodicTimer('consolidation', { type: '_consolidate' }, intervalMs)
        return { state }
      },

      terminated: (state, event) => {
        const entry = Object.entries(state.workers).find(([, ref]) => ref.name === event.ref.name)
        if (!entry) return { state }
        const [userId] = entry
        const { [userId]: _, ...workers } = state.workers
        return { state: { ...state, workers } }
      },
    }),

    handler: onMessage<MemoryConsolidationMsg, ConsolidationState>({
      _turn: (state, msg, context) => {
        let worker    = state.workers[msg.userId]
        let workers   = state.workers
        let workerSeq = state.workerSeq

        if (!worker) {
          if (state.llmRef === null) return { state }
          workerSeq = workerSeq + 1
          worker = context.spawn(
            `consolidation-user-${msg.userId}-${workerSeq}`,
            createUserConsolidationWorker({
              model,
              userId: msg.userId,
              llmRef: state.llmRef,
              tools:  state.tools,
              maxToolLoops,
            }),
            INITIAL_WORKER_STATE,
          )
          workers = { ...workers, [msg.userId]: worker }
        }

        worker.send({
          type:          '_turn',
          userText:      msg.userText,
          assistantText: msg.assistantText,
          timestamp:     msg.timestamp,
        })

        return { state: { ...state, workers, workerSeq } }
      },

      _consolidate: (state) => {
        for (const ref of Object.values(state.workers)) {
          ref.send({ type: '_consolidate' })
        }
        return { state }
      },

      _llmProvider: (state, msg, context) => {
        const updated = { ...state, llmRef: msg.ref }
        return { state: stopAllWorkers(updated, context) }
      },

      _toolRegistered: (state, msg, context) => {
        const updated = { ...state, tools: { ...state.tools, [msg.name]: { schema: msg.schema, ref: msg.ref } } }
        return { state: stopAllWorkers(updated, context) }
      },

      _toolUnregistered: (state, msg, context) => {
        const { [msg.name]: _, ...rest } = state.tools
        const updated = { ...state, tools: rest }
        return { state: stopAllWorkers(updated, context) }
      },
    }),
  }
}

export const INITIAL_CONSOLIDATION_STATE: ConsolidationState = {
  llmRef:    null,
  tools:     {},
  workers:   {},
  workerSeq: 0,
}
