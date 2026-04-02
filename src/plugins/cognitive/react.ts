import { emit } from '../../system/types.ts'
import type { ActorDef, ActorRef, MessageHandler, SpanHandle } from '../../system/types.ts'
import { ask } from '../../system/ask.ts'
import { onLifecycle, onMessage } from '../../system/match.ts'
import { WsSendTopic, MemoryStreamTopic } from '../../types/ws.ts'
import type { ToolCollection, ToolEntry, ToolFilter, ToolInvokeMsg, ToolReply } from '../../types/tools.ts'
import { applyToolFilter, ToolRegistrationTopic } from '../../types/tools.ts'
import { LlmProviderTopic } from '../../types/llm.ts'
import type {
  ApiMessage,
  LlmProviderMsg,
  LlmProviderReply,
  ModelInfo,
  TokenUsage,
  Tool,
  ToolCall,
} from '../../types/llm.ts'
import type { ReActMsg } from '../../types/react.ts'
import { UserContextTopic } from '../../types/memory.ts'

// ─── State ───

type ConversationMessage =
  | { role: 'user';      content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool';      content: string; tool_call_id: string }

type PendingBatch = {
  remaining:          number
  results:            Array<{ toolCallId: string; toolName: string; content: string }>
  messagesAtCall:     ApiMessage[]
  assistantToolCalls: ToolCall[]
}

type SpanHandles = {
  requestSpan: import('../../system/types.ts').SpanHandle
  llmSpan?:    import('../../system/types.ts').SpanHandle
  toolSpans:   Record<string, import('../../system/types.ts').SpanHandle>
}

export type ReActState = {
  // Permanent
  history:          ConversationMessage[]
  tools:            ToolCollection
  modelInfo:        ModelInfo | null
  sessionUsage:     TokenUsage
  llmRef:           ActorRef<LlmProviderMsg> | null
  userContext:      string | null

  // Active turn (set on userMessage, cleared on llmDone/llmError)
  requestId:        string | null
  turnMessages:     ApiMessage[] | null
  spanHandles:      SpanHandles | null
  pendingUsage:     TokenUsage
  pending:          string
  pendingReasoning: string

  // Active tool batch (set on llmToolCalls, cleared when all results arrive)
  pendingBatch:     PendingBatch | null
}

// ─── Options ───

export type ReActActorOptions = {
  clientId:       string
  model:          string
  systemPrompt?:  string
  historyWindow?: number
  toolFilter?:    ToolFilter
}

// ─── Helpers ───

const trimHistory = (history: ConversationMessage[], maxTurns: number): ConversationMessage[] => {
  const userIndices = history.reduce<number[]>((acc, m, i) => { if (m.role === 'user') acc.push(i); return acc }, [])
  if (userIndices.length <= maxTurns) return history
  return history.slice(userIndices[userIndices.length - maxTurns])
}

// ─── Actor definition ───

export const createReActActor = (options: ReActActorOptions): ActorDef<ReActMsg, ReActState> => {
  const { clientId, model, systemPrompt, historyWindow, toolFilter } = options

  // ─── Shared handlers (used across all behaviors) ───

  const toolRegistered = (state: ReActState, msg: Extract<ReActMsg, { type: '_toolRegistered' }>): { state: ReActState } => ({
    state: { ...state, tools: { ...state.tools, [msg.name]: { schema: msg.schema, ref: msg.ref } } },
  })

  const toolUnregistered = (state: ReActState, msg: Extract<ReActMsg, { type: '_toolUnregistered' }>): { state: ReActState } => {
    const { [msg.name]: _, ...rest } = state.tools
    return { state: { ...state, tools: rest } }
  }

  const llmProviderUpdated = (state: ReActState, msg: Extract<ReActMsg, { type: '_llmProviderUpdated' }>): { state: ReActState } => ({
    state: { ...state, llmRef: msg.ref },
  })

  // ─── Forward declarations for circular references ───

  let awaitingLlmHandler: MessageHandler<ReActMsg, ReActState>
  let toolLoopHandler: MessageHandler<ReActMsg, ReActState>

  // ─── Handler: idle — waiting for user input ───

  const idleHandler: MessageHandler<ReActMsg, ReActState> = onMessage<ReActMsg, ReActState>({
    userMessage: (state, message, context) => {
      const { text, images, audio, traceId, parentSpanId } = message

      let userText = text
      if (images && images.length > 0) {
        const imageNote = images.length === 1
          ? `[Image attached: "${images[0]}"]`
          : `[Images attached: ${images.map(p => `"${p}"`).join(', ')}]`
        userText = text ? `${text}\n\n${imageNote}` : imageNote
      }
      if (audio) {
        const audioNote = `[Audio attached: "${audio}"]`
        userText = userText ? `${userText}\n\n${audioNote}` : audioNote
      }

      const fullSystemPrompt = [systemPrompt, state.userContext].filter(Boolean).join('\n\n---\n\n')
      const apiMessages: ApiMessage[] = [
        ...(fullSystemPrompt ? [{ role: 'system' as const, content: fullSystemPrompt }] : []),
        ...state.history,
        { role: 'user', content: userText },
      ]

      const requestSpan = context.trace.child(traceId, parentSpanId, 'react', { preview: text.slice(0, 80) })
      const llmSpan = context.trace.child(requestSpan.traceId, requestSpan.spanId, 'llm-call', { model })

      const toolSchemas = Object.values(state.tools).map((e: ToolEntry) => e.schema as Tool)
      const tools = toolSchemas.length > 0 ? toolSchemas : undefined

      const requestId = crypto.randomUUID()

      state.llmRef?.send({
        type: 'stream',
        requestId,
        model,
        messages: apiMessages,
        tools,
        replyTo: context.self as unknown as ActorRef<LlmProviderReply>,
      })

      return {
        state: {
          ...state,
          history: [...state.history, { role: 'user', content: userText }],
          requestId,
          turnMessages: apiMessages,
          pending: '',
          pendingReasoning: '',
          pendingUsage: { promptTokens: 0, completionTokens: 0 },
          spanHandles: { requestSpan, llmSpan, toolSpans: {} },
        },
        become: awaitingLlmHandler,
      }
    },

    _toolRegistered:     toolRegistered,
    _toolUnregistered:   toolUnregistered,
    _llmProviderUpdated: llmProviderUpdated,
    _userContext:        (state, msg) => ({ state: { ...state, userContext: msg.summary } }),
  })

  // ─── Handler: awaitingLlm — LLM running, will return tool calls or text ───

  awaitingLlmHandler = onMessage<ReActMsg, ReActState>({
    llmToolCalls: (state, message, context) => {
      const { requestId, calls, usage } = message
      if (requestId !== state.requestId) return { state }

      const handles = state.spanHandles
      handles?.llmSpan?.done({ toolCalls: calls.map(c => c.name) })

      const mergedPending: TokenUsage = usage
        ? { promptTokens: state.pendingUsage.promptTokens + usage.promptTokens, completionTokens: state.pendingUsage.completionTokens + usage.completionTokens }
        : state.pendingUsage

      const unknownCall = calls.find(c => !state.tools[c.name])
      if (unknownCall) {
        handles?.requestSpan.error('tool unavailable')
        return {
          state: { ...state, requestId: null, turnMessages: null, spanHandles: null, pendingUsage: { promptTokens: 0, completionTokens: 0 } },
          events: [emit(WsSendTopic, { clientId, text: JSON.stringify({ type: 'error', text: 'Tool unavailable. Please try again.' }) })],
          become: idleHandler,
        }
      }

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

      const newToolSpans: Record<string, SpanHandle> = {}
      for (const call of calls) {
        const entry = state.tools[call.name]!
        const toolSpan = handles
          ? context.trace.child(handles.requestSpan.traceId, handles.requestSpan.spanId, 'tool-invoke', { toolName: call.name })
          : null
        if (toolSpan) newToolSpans[call.id] = toolSpan

        context.pipeToSelf(
          ask<ToolInvokeMsg, ToolReply>(
            entry.ref,
            (replyTo) => ({ type: 'invoke', toolName: call.name, arguments: call.arguments, replyTo, clientId }),
            undefined,
            toolSpan ? context.trace.injectHeaders(toolSpan) : undefined,
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
        state: {
          ...state,
          requestId: null,
          pendingUsage: mergedPending,
          pendingBatch: batch,
          ...(handles ? { spanHandles: { ...handles, llmSpan: undefined, toolSpans: newToolSpans } } : {}),
        },
        events: [emit(WsSendTopic, { clientId, text: JSON.stringify({ type: 'searching', tools: calls.map(c => c.name) }) })],
        become: toolLoopHandler,
      }
    },

    llmChunk: (state, message) => {
      if (message.requestId !== state.requestId) return { state }
      const { text } = message
      return {
        state: { ...state, pending: state.pending + text },
        events: [emit(WsSendTopic, { clientId, text: JSON.stringify({ type: 'chunk', text }) })],
      }
    },

    llmReasoningChunk: (state, message) => {
      if (message.requestId !== state.requestId) return { state }
      const { text } = message
      return {
        state: { ...state, pendingReasoning: state.pendingReasoning + text },
        events: [emit(WsSendTopic, { clientId, text: JSON.stringify({ type: 'reasoningChunk', text }) })],
      }
    },

    llmDone: (state, message) => {
      const { requestId, usage } = message
      if (requestId !== state.requestId) return { state }

      const handles = state.spanHandles
      handles?.llmSpan?.done()
      handles?.requestSpan.done()

      const accumulated = state.pendingUsage
      const totalUsage: TokenUsage | null = usage
        ? { promptTokens: accumulated.promptTokens + usage.promptTokens, completionTokens: accumulated.completionTokens + usage.completionTokens }
        : (accumulated.promptTokens > 0 ? accumulated : null)

      const prevSession = state.sessionUsage
      const newSession: TokenUsage = totalUsage
        ? { promptTokens: prevSession.promptTokens + totalUsage.promptTokens, completionTokens: prevSession.completionTokens + totalUsage.completionTokens }
        : prevSession

      const info = state.modelInfo

      const rawHistory: ConversationMessage[] = [...state.history, { role: 'assistant', content: state.pending }]
      const newHistory = historyWindow ? trimHistory(rawHistory, historyWindow) : rawHistory

      const userMsg = state.turnMessages?.findLast(m => m.role === 'user')
      const userText = typeof userMsg?.content === 'string' ? userMsg.content : ''

      return {
        state: {
          ...state,
          history: newHistory,
          pending: '',
          pendingReasoning: '',
          requestId: null,
          turnMessages: null,
          spanHandles: null,
          pendingUsage: { promptTokens: 0, completionTokens: 0 },
          sessionUsage: newSession,
        },
        events: [
          emit(MemoryStreamTopic, { userId: 'default', userText, assistantText: state.pending, timestamp: Date.now() }),
          emit(WsSendTopic, { clientId, text: JSON.stringify({ type: 'done' }) }),
          emit(WsSendTopic, { clientId, text: JSON.stringify({
            type: 'usage',
            role: 'reasoning',
            model,
            inputTokens:   totalUsage?.promptTokens     ?? 0,
            outputTokens:  totalUsage?.completionTokens ?? 0,
            contextWindow: info?.contextWindow ?? null,
            cost: info && totalUsage
              ? (totalUsage.promptTokens     / 1_000_000 * info.promptPer1M)
              + (totalUsage.completionTokens / 1_000_000 * info.completionPer1M)
              : null,
          })}),
        ],
        become: idleHandler,
      }
    },

    llmError: (state, message, context) => {
      const { requestId, error } = message
      if (requestId !== state.requestId) return { state }

      context.log.error('LLM stream failed', { clientId, error: String(error) })
      state.spanHandles?.llmSpan?.error(error)
      state.spanHandles?.requestSpan?.error(error)

      return {
        state: { ...state, requestId: null, turnMessages: null, spanHandles: null, pending: '', pendingReasoning: '', pendingUsage: { promptTokens: 0, completionTokens: 0 } },
        events: [emit(WsSendTopic, { clientId, text: JSON.stringify({ type: 'error', text: 'Something went wrong. Please try again.' }) })],
        become: idleHandler,
      }
    },

    _toolRegistered:     toolRegistered,
    _toolUnregistered:   toolUnregistered,
    _llmProviderUpdated: llmProviderUpdated,
    _userContext:        (state, msg) => ({ state: { ...state, userContext: msg.summary } }),
  })

  // ─── Handler: toolLoop — tools executing, accumulating results ───

  toolLoopHandler = onMessage<ReActMsg, ReActState>({
    _toolResult: (state, message, context) => {
      const { toolName, toolCallId, reply } = message
      const batch = state.pendingBatch!
      const handles = state.spanHandles

      const toolSpan = handles?.toolSpans[toolCallId]
      if (toolSpan) {
        reply.type === 'toolResult' ? toolSpan.done() : toolSpan.error(reply.error)
      }

      const content = reply.type === 'toolResult' ? reply.result : `Tool error: ${reply.error}`
      const sources = reply.type === 'toolResult' ? reply.sources : undefined
      const updatedResults = [...batch.results, { toolCallId, toolName, content }]
      const remaining = batch.remaining - 1

      const sourceEvents = sources
        ? [emit(WsSendTopic, { clientId, text: JSON.stringify({ type: 'sources', sources }) })]
        : []

      if (remaining > 0) {
        return {
          state: { ...state, pendingBatch: { ...batch, remaining, results: updatedResults } },
          events: sourceEvents,
        }
      }

      // All tools done — build next LLM request, loop back to awaitingLlm
      const toolResultMsgs: ApiMessage[] = updatedResults.map(r => ({
        role: 'tool', content: r.content, tool_call_id: r.toolCallId,
      }))
      const messagesWithResults: ApiMessage[] = [
        ...batch.messagesAtCall,
        { role: 'assistant', content: null, tool_calls: batch.assistantToolCalls },
        ...toolResultMsgs,
      ]

      const toolCallHistoryMsgs: Array<ConversationMessage> = [
        { role: 'assistant', content: null, tool_calls: batch.assistantToolCalls },
        ...updatedResults.map(r => ({ role: 'tool' as const, content: r.content, tool_call_id: r.toolCallId })),
      ]

      const llmSpan = handles
        ? context.trace.child(handles.requestSpan.traceId, handles.requestSpan.spanId, 'llm-response', { model })
        : null

      const requestId = crypto.randomUUID()
      const toolSchemas = Object.values(state.tools).map((e: ToolEntry) => e.schema as Tool)
      const tools = toolSchemas.length > 0 ? toolSchemas : undefined

      state.llmRef?.send({
        type: 'stream',
        requestId,
        model,
        messages: messagesWithResults,
        tools,
        replyTo: context.self as unknown as ActorRef<LlmProviderReply>,
      })

      return {
        state: {
          ...state,
          requestId,
          turnMessages: messagesWithResults,
          history: [...state.history, ...toolCallHistoryMsgs],
          pendingBatch: null,
          pending: '',
          ...(handles ? { spanHandles: { ...handles, llmSpan: llmSpan ?? undefined, toolSpans: {} } } : {}),
        },
        events: sourceEvents,
        become: awaitingLlmHandler,
      }
    },

    _toolRegistered:     toolRegistered,
    _toolUnregistered:   toolUnregistered,
    _llmProviderUpdated: llmProviderUpdated,
    _userContext:        (state, msg) => ({ state: { ...state, userContext: msg.summary } }),
  })

  return {
    lifecycle: onLifecycle({
      start: async (state, context) => {
        context.subscribe(ToolRegistrationTopic, (event) => {
          if (!applyToolFilter(event.name, toolFilter)) return null
          return event.ref === null
            ? { type: '_toolUnregistered' as const, name: event.name }
            : { type: '_toolRegistered' as const, name: event.name, schema: event.schema, ref: event.ref }
        })

        context.subscribe(LlmProviderTopic, (event) =>
          ({ type: '_llmProviderUpdated' as const, ref: event.ref }),
        )

        context.subscribe(UserContextTopic, (event) =>
          ({ type: '_userContext' as const, summary: event.summary }),
        )

        const modelInfo = state.llmRef
          ? await ask<LlmProviderMsg, ModelInfo | null>(state.llmRef, (replyTo) => ({ type: 'fetchModelInfo', model, replyTo }))
              .catch(() => null)
          : null

        return { state: { ...state, modelInfo } }
      },
    }),

    handler: idleHandler,

    supervision: { type: 'restart', maxRetries: 3, withinMs: 30_000 },
  }
}
