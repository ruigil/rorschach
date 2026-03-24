import { emit } from '../../system/types.ts'
import type { ActorDef, ActorRef, MessageHandler, SpanHandle } from '../../system/types.ts'
import { ask } from '../../system/ask.ts'
import { onLifecycle, onMessage } from '../../system/match.ts'
import { WsSendTopic } from '../interfaces/http.ts'
import type { ToolCollection, ToolEntry, ToolInvokeMsg, ToolReply, ToolSchema } from '../../system/tools.ts'
import { ToolRegistrationTopic } from '../../system/tools.ts'
import type {
  ApiMessage,
  LlmProviderMsg,
  LlmProviderReply,
  ModelInfo,
  TokenUsage,
  Tool,
  ToolCall,
} from './llm-provider.ts'

// ─── Message protocol ───

export type ChatbotMsg =
  | { type: 'userMessage'; text: string; images?: string[]; traceId: string; parentSpanId: string }
  | LlmProviderReply
  | { type: '_toolRegistered';   name: string; schema: ToolSchema; ref: ActorRef<ToolInvokeMsg> }
  | { type: '_toolUnregistered'; name: string }
  | { type: '_toolResult';       toolName: string; toolCallId: string; reply: ToolReply }

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

export type ChatbotState = {
  // Permanent
  history:          ConversationMessage[]
  tools:            ToolCollection
  modelInfo:        ModelInfo | null
  sessionUsage:     TokenUsage

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

export type ChatbotActorOptions = {
  clientId:     string
  llmRef:       ActorRef<LlmProviderMsg>
  model:        string
  systemPrompt?: string
}

// ─── Actor definition ───

export const createChatbotActor = (options: ChatbotActorOptions): ActorDef<ChatbotMsg, ChatbotState> => {
  const { clientId, llmRef, model, systemPrompt } = options

  // ─── Shared tool registration handlers (used across all behaviors) ───

  const toolRegistered = (state: ChatbotState, msg: Extract<ChatbotMsg, { type: '_toolRegistered' }>): { state: ChatbotState } => ({
    state: { ...state, tools: { ...state.tools, [msg.name]: { schema: msg.schema, ref: msg.ref } } },
  })

  const toolUnregistered = (state: ChatbotState, msg: Extract<ChatbotMsg, { type: '_toolUnregistered' }>): { state: ChatbotState } => {
    const { [msg.name]: _, ...rest } = state.tools
    return { state: { ...state, tools: rest } }
  }

  // ─── Forward declarations for circular references ───

  let awaitingLlmHandler: MessageHandler<ChatbotMsg, ChatbotState>
  let toolLoopHandler: MessageHandler<ChatbotMsg, ChatbotState>

  // ─── Handler: idle — waiting for user input ───

  const idleHandler: MessageHandler<ChatbotMsg, ChatbotState> = onMessage<ChatbotMsg, ChatbotState>({
    userMessage: (state, message, context) => {
      const { text, images, traceId, parentSpanId } = message

      let userText = text
      if (images && images.length > 0) {
        const imageNote = images.length === 1
          ? `[Image attached: "${images[0]}"]`
          : `[Images attached: ${images.map(p => `"${p}"`).join(', ')}]`
        userText = text ? `${text}\n\n${imageNote}` : imageNote
      }

      const apiMessages: ApiMessage[] = [
        ...(systemPrompt ? [{ role: 'system' as const, content: systemPrompt }] : []),
        ...state.history,
        { role: 'user', content: userText },
      ]

      const requestSpan = context.trace.child(traceId, parentSpanId, 'chatbot', { preview: text.slice(0, 80) })
      const llmSpan = context.trace.child(requestSpan.traceId, requestSpan.spanId, 'llm-call', { model })

      const toolSchemas = Object.values(state.tools).map((e: ToolEntry) => e.schema as Tool)
      const tools = toolSchemas.length > 0 ? toolSchemas : undefined

      const requestId = crypto.randomUUID()

      llmRef.send({
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

    _toolRegistered:   toolRegistered,
    _toolUnregistered: toolUnregistered,
  })

  // ─── Handler: awaitingLlm — LLM running, will return tool calls or text ───

  awaitingLlmHandler = onMessage<ChatbotMsg, ChatbotState>({
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
            (replyTo) => ({ type: 'invoke', toolName: call.name, arguments: call.arguments, replyTo }),
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
      const sessionCost = info
        ? (newSession.promptTokens / 1_000_000 * info.promptPer1M) + (newSession.completionTokens / 1_000_000 * info.completionPer1M)
        : null
      const contextPercent = (info && usage)
        ? (usage.promptTokens + usage.completionTokens) / info.contextWindow
        : null

      return {
        state: {
          ...state,
          history: [...state.history, { role: 'assistant', content: state.pending }],
          pending: '',
          pendingReasoning: '',
          requestId: null,
          turnMessages: null,
          spanHandles: null,
          pendingUsage: { promptTokens: 0, completionTokens: 0 },
          sessionUsage: newSession,
        },
        events: [
          emit(WsSendTopic, { clientId, text: JSON.stringify({ type: 'done' }) }),
          emit(WsSendTopic, { clientId, text: JSON.stringify({
            type: 'usage',
            model,
            inputTokens: newSession.promptTokens,
            outputTokens: newSession.completionTokens,
            contextWindow: info?.contextWindow ?? null,
            contextPercent,
            sessionCost,
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

    _toolRegistered:   toolRegistered,
    _toolUnregistered: toolUnregistered,
  })

  // ─── Handler: toolLoop — tools executing, accumulating results ───

  toolLoopHandler = onMessage<ChatbotMsg, ChatbotState>({
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

      llmRef.send({
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

    _toolRegistered:   toolRegistered,
    _toolUnregistered: toolUnregistered,
  })

  return {
    lifecycle: onLifecycle({
      async start(state, context) {
        context.subscribe(ToolRegistrationTopic, (event) =>
          event.ref === null
            ? { type: '_toolUnregistered' as const, name: event.name }
            : { type: '_toolRegistered' as const, name: event.name, schema: event.schema, ref: event.ref },
        )

        const modelInfo = await ask<LlmProviderMsg, ModelInfo | null>(llmRef, (replyTo) => ({ type: 'fetchModelInfo', model, replyTo }))
          .catch(() => null)

        return { state: { ...state, modelInfo } }
      },
    }),

    handler: idleHandler,

    supervision: { type: 'restart', maxRetries: 3, withinMs: 30_000 },
  }
}
