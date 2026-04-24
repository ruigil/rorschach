import type { ActorDef, ActorRef, ActorResult, MessageHandler } from '../../system/types.ts'
import { onLifecycle, onMessage } from '../../system/match.ts'
import { MemoryStreamTopic } from '../../types/events.ts'
import type { MemoryTurnEvent } from '../../types/events.ts'
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
import type { MemoryConsolidationMsg, UserContextMsg } from '../../types/memory.ts'
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

// ─── Internal types ───

type PendingBatch = {
  remaining:          number
  results:            Array<{ toolCallId: string; toolName: string; content: string }>
  messagesAtCall:     ApiMessage[]
  assistantToolCalls: ToolCall[]
}

export type ConsolidationState = {
  llmRef:             ActorRef<LlmProviderMsg> | null
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
  toolLoopCount:      number

  // Spawned user-context actors keyed by userId
  userContexts:       Record<string, ActorRef<UserContextMsg>>
}

// ─── Helpers ───

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
  const { model, intervalMs, toolFilter, maxToolLoops = 25 } = options

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
      role: 'memory-consolidation',
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
        toolLoopCount: 0,
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

    _llmProvider:      (state, msg) => ({ state: { ...state, llmRef: msg.ref } }),
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
            (replyTo) => ({ type: 'invoke', toolName: call.name, arguments: call.arguments, replyTo, userId: state.activeUserId ?? undefined }),
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
          Object.entries(state.tools).filter(([n]) => n === 'read' || n.startsWith('zettel_')),
        ) as ToolCollection
        ucRef = context.spawn(
          `user-context-${doneUserId}`,
          createUserContextActor({ model, userId: doneUserId, llmRef: state.llmRef!, tools: userContextTools }),
          INITIAL_USER_CONTEXT_STATE,
        )
      }
      ucRef.send({ type: '_run' })
      const userContexts = { ...state.userContexts, [doneUserId]: ucRef }

      return startNextConsolidation(
        { ...state, requestId: null, turnMessages: null, accumulated: '', activeUserId: null, userContexts },
        context,
      ) as ActorResult<MemoryConsolidationMsg, ConsolidationState>
    },

    llmError: (state, msg, context) => {
      if (msg.requestId !== state.requestId) return { state }
      context.log.error('memory consolidation LLM error', { userId: state.activeUserId, error: String(msg.error) })
      return startNextConsolidation(
        { ...state, requestId: null, turnMessages: null, accumulated: '', activeUserId: null },
        context,
      )
    },

    _llmProvider:      (state, msg) => ({ state: { ...state, llmRef: msg.ref } }),
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

      // All tools done — check loop limit before looping back
      const nextLoopCount = state.toolLoopCount + 1

      if (nextLoopCount >= maxToolLoops) {
        context.log.warn('memory consolidation tool loop limit reached', { userId: state.activeUserId, limit: maxToolLoops })
        return startNextConsolidation(
          { ...state, requestId: null, turnMessages: null, accumulated: '', pendingBatch: null, activeUserId: null, toolLoopCount: 0 },
          context,
        )
      }

      // Build next LLM request
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
        role: 'memory-consolidation',
        replyTo: context.self as unknown as ActorRef<LlmProviderReply>,
      })

      return {
        state: { ...state, requestId, turnMessages: nextMessages, pendingBatch: null, toolLoopCount: nextLoopCount },
        become: awaitingLlmHandler,
      }
    },

    _llmProvider:      (state, msg) => ({ state: { ...state, llmRef: msg.ref } }),
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
  tools:              {},
  buffer:             {},
  activeUserId:       null,
  consolidationQueue: [],
  requestId:          null,
  turnMessages:       null,
  accumulated:        '',
  pendingBatch:       null,
  toolLoopCount:      0,
  userContexts:       {},
}
