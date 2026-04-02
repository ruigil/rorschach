import type { ActorDef, ActorRef, MessageHandler } from '../../system/types.ts'
import { onLifecycle, onMessage } from '../../system/match.ts'
import { emit } from '../../system/types.ts'
import { MemoryStreamTopic, WsBroadcastTopic } from '../../types/ws.ts'
import type { MemoryTurnEvent } from '../../types/ws.ts'
import type { ToolCollection, ToolEntry, ToolFilter, ToolInvokeMsg, ToolReply } from '../../types/tools.ts'
import { applyToolFilter, ToolRegistrationTopic } from '../../types/tools.ts'
import { ask } from '../../system/ask.ts'
import type {
  ApiMessage,
  LlmProviderMsg,
  LlmProviderReply,
  ModelInfo,
  Tool,
  ToolCall,
} from '../../types/llm.ts'
import { LlmProviderTopic } from '../../types/llm.ts'
import type { MemoryConsolidationMsg, UserContextMsg } from '../../types/memory.ts'
import { createUserContextActor, INITIAL_USER_CONTEXT_STATE } from './user-context.ts'

// ─── Options ───

export type MemoryConsolidationOptions = {
  model:       string
  intervalMs:  number
  toolFilter?: ToolFilter
}

// ─── Internal types ───

type PendingBatch = {
  remaining:          number
  results:            Array<{ toolCallId: string; toolName: string; content: string }>
  messagesAtCall:     ApiMessage[]
  assistantToolCalls: ToolCall[]
}

export type ConsolidationState = {
  llmRef:             ActorRef<LlmProviderMsg> | null
  modelInfo:          ModelInfo | null
  tools:              ToolCollection

  // Per-user turn buffer
  buffer:             Record<string, MemoryTurnEvent[]>

  // Active consolidation session
  activeUserId:       string | null
  consolidationQueue: string[]

  // Active LLM agent loop
  requestId:          string | null
  turnMessages:       ApiMessage[] | null
  accumulated:        string
  pendingBatch:       PendingBatch | null

  // Spawned user-context actors keyed by userId
  userContexts:       Record<string, ActorRef<UserContextMsg>>
}

// ─── System prompt ───

const buildSystemPrompt = (userId: string): string =>
  `You are a user model agent for user "${userId}". Your goal is to build and maintain a rich, accurate model of this user — their identity, projects, preferences, interests, working style, and goals.\n\n` +
  `You have access to three memory stores:\n` +
  `- Episodic (markdown): notable events, decisions, experiences → /workspace/memory/${userId}/episodic/YYYY-MM-DD.md (append). Record what happened, what was decided, and why.\n` +
  `- Procedural (markdown): skills, workflows, preferences, tools, recurring patterns → /workspace/memory/${userId}/procedural/{topic}.md (update in-place). Keep these concise and current.\n` +
  `- Semantic (kgraph): entities, facts, and relationships → use kgraph_write with MERGE. Add a filePath property on nodes that reference their markdown file.\n\n` +
  `Use bash to mkdir -p directories before writing. Read existing files with read before appending to avoid duplication. Skip small talk. Prioritize information that reveals who this user is, how they think, and what they are working on.`

const buildMessages = (userId: string, turns: MemoryTurnEvent[]): ApiMessage[] => {
  const turnList = turns.map((t, i) => {
    const date = new Date(t.timestamp).toISOString()
    return `Turn ${i + 1} [${date}]\nUser: ${t.userText}\nAssistant: ${t.assistantText}`
  }).join('\n\n')
  return [
    { role: 'system', content: buildSystemPrompt(userId) },
    { role: 'user', content: `Please consolidate these conversation turns into memory:\n\n${turnList}` },
  ]
}

// ─── Shared tool handlers ───

const toolRegistered = (state: ConsolidationState, msg: Extract<MemoryConsolidationMsg, { type: '_toolRegistered' }>): { state: ConsolidationState } => ({
  state: { ...state, tools: { ...state.tools, [msg.name]: { schema: msg.schema, ref: msg.ref } } },
})

const toolUnregistered = (state: ConsolidationState, msg: Extract<MemoryConsolidationMsg, { type: '_toolUnregistered' }>): { state: ConsolidationState } => {
  const { [msg.name]: _, ...rest } = state.tools
  return { state: { ...state, tools: rest } }
}

// ─── Actor definition ───

export const createMemoryConsolidationActor = (options: MemoryConsolidationOptions): ActorDef<MemoryConsolidationMsg, ConsolidationState> => {
  const { model, intervalMs, toolFilter } = options

  let awaitingLlmHandler: MessageHandler<MemoryConsolidationMsg, ConsolidationState>
  let toolLoopHandler:    MessageHandler<MemoryConsolidationMsg, ConsolidationState>

  // ─── Start next consolidation from queue ───

  const startNextConsolidation = (
    state: ConsolidationState,
    context: Parameters<MessageHandler<MemoryConsolidationMsg, ConsolidationState>>[2],
  ): ReturnType<MessageHandler<MemoryConsolidationMsg, ConsolidationState>> => {
    if (state.llmRef === null || state.consolidationQueue.length === 0) {
      return { state: { ...state, activeUserId: null }, become: idleHandler }
    }

    const nextUserId = state.consolidationQueue[0]!
    const remainingQueue = state.consolidationQueue.slice(1)
    const snapshotTurns = state.buffer[nextUserId] ?? []

    if (snapshotTurns.length === 0) {
      return startNextConsolidation({ ...state, consolidationQueue: remainingQueue }, context)
    }

    const { [nextUserId]: _dropped, ...remainingBuffer } = state.buffer

    const requestId = crypto.randomUUID()
    const messages = buildMessages(nextUserId, snapshotTurns)
    const toolSchemas = Object.values(state.tools).map((e: ToolEntry) => e.schema as Tool)

    state.llmRef.send({
      type: 'stream',
      requestId,
      model,
      messages,
      tools: toolSchemas.length > 0 ? toolSchemas : undefined,
      replyTo: context.self as unknown as ActorRef<LlmProviderReply>,
    })

    context.log.info('memory consolidation started', { userId: nextUserId, turns: snapshotTurns.length })

    return {
      state: {
        ...state,
        buffer: remainingBuffer,
        activeUserId: nextUserId,
        consolidationQueue: remainingQueue,
        requestId,
        turnMessages: messages,
        accumulated: '',
        pendingBatch: null,
      },
      become: awaitingLlmHandler,
    }
  }

  // ─── Enqueue users with pending turns ───

  const enqueueNewUsers = (state: ConsolidationState): ConsolidationState => {
    const newUserIds = Object.keys(state.buffer).filter(
      uid =>
        (state.buffer[uid]?.length ?? 0) > 0 &&
        uid !== state.activeUserId &&
        !state.consolidationQueue.includes(uid),
    )
    if (newUserIds.length === 0) return state
    return { ...state, consolidationQueue: [...state.consolidationQueue, ...newUserIds] }
  }

  // ─── Shared buffer handler ───

  const bufferTurn = (state: ConsolidationState, msg: Extract<MemoryConsolidationMsg, { type: '_turn' }>): { state: ConsolidationState } => ({
    state: {
      ...state,
      buffer: {
        ...state.buffer,
        [msg.userId]: [...(state.buffer[msg.userId] ?? []), { userId: msg.userId, userText: msg.userText, assistantText: msg.assistantText, timestamp: msg.timestamp }],
      },
    },
  })

  // ─── Handler: idle ───

  const idleHandler: MessageHandler<MemoryConsolidationMsg, ConsolidationState> = onMessage<MemoryConsolidationMsg, ConsolidationState>({
    _turn: bufferTurn,

    _consolidate: (state, _, context) => {
      if (state.llmRef === null) return { state }
      const updated = enqueueNewUsers(state)
      if (updated.consolidationQueue.length === 0) return { state }
      return startNextConsolidation(updated, context)
    },

    _llmProvider:      (state, msg, context) => {
      if (msg.ref) {
        context.pipeToSelf(
          ask<LlmProviderMsg, ModelInfo | null>(msg.ref, (replyTo) => ({ type: 'fetchModelInfo', model, replyTo })),
          (info): MemoryConsolidationMsg => ({ type: '_modelInfo', info }),
          ():    MemoryConsolidationMsg => ({ type: '_modelInfo', info: null }),
        )
      }
      return { state: { ...state, llmRef: msg.ref } }
    },
    _modelInfo:        (state, msg) => ({ state: { ...state, modelInfo: msg.info } }),
    _toolRegistered:   toolRegistered,
    _toolUnregistered: toolUnregistered,
  })

  // ─── Handler: awaitingLlm ───

  awaitingLlmHandler = onMessage<MemoryConsolidationMsg, ConsolidationState>({
    _turn: bufferTurn,

    _consolidate: (state) => ({ state: enqueueNewUsers(state) }),

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
        const entry = state.tools[call.name]
        if (!entry) {
          context.log.warn('memory consolidation: unknown tool', { tool: call.name })
          continue
        }
        context.pipeToSelf(
          ask<ToolInvokeMsg, ToolReply>(
            entry.ref,
            (replyTo) => ({ type: 'invoke', toolName: call.name, arguments: call.arguments, replyTo }),
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

    llmDone: (state, msg, context) => {
      if (msg.requestId !== state.requestId) return { state }
      const doneUserId = state.activeUserId!
      context.log.info('memory consolidation done', { userId: doneUserId })

      let ucRef = state.userContexts[doneUserId]
      if (!ucRef) {
        const userContextTools = Object.fromEntries(
          Object.entries(state.tools).filter(([n]) => n === 'read' || n === 'kgraph_query'),
        ) as ToolCollection
        ucRef = context.spawn(
          `user-context-${doneUserId}`,
          createUserContextActor({ model, userId: doneUserId, llmRef: state.llmRef!, tools: userContextTools }),
          INITIAL_USER_CONTEXT_STATE,
        )
      }
      ucRef.send({ type: '_run' })
      const userContexts = { ...state.userContexts, [doneUserId]: ucRef }

      const usageEvents = msg.usage
        ? [emit(WsBroadcastTopic, { text: JSON.stringify({
            type: 'usage',
            role: 'memory',
            model,
            inputTokens:   msg.usage.promptTokens,
            outputTokens:  msg.usage.completionTokens,
            contextWindow: state.modelInfo?.contextWindow ?? null,
            cost: state.modelInfo
              ? (msg.usage.promptTokens     / 1_000_000 * state.modelInfo.promptPer1M)
              + (msg.usage.completionTokens / 1_000_000 * state.modelInfo.completionPer1M)
              : null,
          }) })]
        : []

      return {
        ...startNextConsolidation(
          { ...state, requestId: null, turnMessages: null, accumulated: '', activeUserId: null, userContexts },
          context,
        ),
        events: usageEvents,
      }
    },

    llmError: (state, msg, context) => {
      if (msg.requestId !== state.requestId) return { state }
      context.log.error('memory consolidation LLM error', { userId: state.activeUserId, error: String(msg.error) })
      return startNextConsolidation(
        { ...state, requestId: null, turnMessages: null, accumulated: '', activeUserId: null },
        context,
      )
    },

    _llmProvider:      (state, msg, context) => {
      if (msg.ref) {
        context.pipeToSelf(
          ask<LlmProviderMsg, ModelInfo | null>(msg.ref, (replyTo) => ({ type: 'fetchModelInfo', model, replyTo })),
          (info): MemoryConsolidationMsg => ({ type: '_modelInfo', info }),
          ():    MemoryConsolidationMsg => ({ type: '_modelInfo', info: null }),
        )
      }
      return { state: { ...state, llmRef: msg.ref } }
    },
    _modelInfo:        (state, msg) => ({ state: { ...state, modelInfo: msg.info } }),
    _toolRegistered:   toolRegistered,
    _toolUnregistered: toolUnregistered,
  })

  // ─── Handler: toolLoop ───

  toolLoopHandler = onMessage<MemoryConsolidationMsg, ConsolidationState>({
    _turn: bufferTurn,

    _consolidate: (state) => ({ state: enqueueNewUsers(state) }),

    _toolResult: (state, msg, context) => {
      const batch = state.pendingBatch!
      const content = msg.reply.type === 'toolResult' ? msg.reply.result : `Tool error: ${msg.reply.error}`
      const updatedResults = [...batch.results, { toolCallId: msg.toolCallId, toolName: msg.toolName, content }]
      const remaining = batch.remaining - 1

      if (remaining > 0) {
        return { state: { ...state, pendingBatch: { ...batch, remaining, results: updatedResults } } }
      }

      // All tools done — build next LLM request
      const toolResultMsgs: ApiMessage[] = updatedResults.map(r => ({
        role: 'tool', content: r.content, tool_call_id: r.toolCallId,
      }))
      const nextMessages: ApiMessage[] = [
        ...batch.messagesAtCall,
        { role: 'assistant', content: null, tool_calls: batch.assistantToolCalls },
        ...toolResultMsgs,
      ]

      context.log.debug(JSON.stringify(toolResultMsgs))

      const requestId = crypto.randomUUID()
      const toolSchemas = Object.values(state.tools).map((e: ToolEntry) => e.schema as Tool)

      state.llmRef!.send({
        type: 'stream',
        requestId,
        model,
        messages: nextMessages,
        tools: toolSchemas.length > 0 ? toolSchemas : undefined,
        replyTo: context.self as unknown as ActorRef<LlmProviderReply>,
      })

      return {
        state: { ...state, requestId, turnMessages: nextMessages, pendingBatch: null },
        become: awaitingLlmHandler,
      }
    },

    _llmProvider:      (state, msg, context) => {
      if (msg.ref) {
        context.pipeToSelf(
          ask<LlmProviderMsg, ModelInfo | null>(msg.ref, (replyTo) => ({ type: 'fetchModelInfo', model, replyTo })),
          (info): MemoryConsolidationMsg => ({ type: '_modelInfo', info }),
          ():    MemoryConsolidationMsg => ({ type: '_modelInfo', info: null }),
        )
      }
      return { state: { ...state, llmRef: msg.ref } }
    },
    _modelInfo:        (state, msg) => ({ state: { ...state, modelInfo: msg.info } }),
    _toolRegistered:   toolRegistered,
    _toolUnregistered: toolUnregistered,
  })

  return {
    lifecycle: onLifecycle({
      start: (_state, context) => {
        context.subscribe(MemoryStreamTopic, (e) => ({
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
        return { state: _state }
      },
    }),

    handler: idleHandler,
  }
}

export const INITIAL_CONSOLIDATION_STATE: ConsolidationState = {
  llmRef:             null,
  modelInfo:          null,
  tools:              {},
  buffer:             {},
  activeUserId:       null,
  consolidationQueue: [],
  requestId:          null,
  turnMessages:       null,
  accumulated:        '',
  pendingBatch:       null,
  userContexts:       {},
}
