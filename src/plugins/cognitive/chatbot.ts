import { emit } from '../../system/types.ts'
import type { ActorDef, ActorRef, SpanHandle } from '../../system/types.ts'
import { ask } from '../../system/ask.ts'
import { onLifecycle, onMessage } from '../../system/match.ts'
import { WsMessageTopic, WsSendTopic } from '../interfaces/http.ts'
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

type ChatbotMsg =
  | { type: 'userMessage';       clientId: string; text: string; images?: string[]; traceId: string; parentSpanId: string }
  | LlmProviderReply
  | { type: '_toolRegistered';   name: string; schema: ToolSchema; ref: ActorRef<ToolInvokeMsg> }
  | { type: '_toolUnregistered'; name: string }
  | { type: '_toolResult';       clientId: string; toolName: string; toolCallId: string; reply: ToolReply }

// ─── State ───

type ConversationMessage =
  | { role: 'user';      content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool';      content: string; tool_call_id: string }

type PendingBatch = {
  remaining: number
  results: Array<{ toolCallId: string; toolName: string; content: string }>
  messagesAtCall: ApiMessage[]
  assistantToolCalls: ToolCall[]
}

type PendingLlmRequest = {
  messagesAtCall: ApiMessage[]
  toolCollection: ToolCollection
}

type SpanHandles = {
  requestSpan: SpanHandle
  llmSpan?: SpanHandle
  toolSpans: Record<string, SpanHandle>
}

export type ChatbotState = {
  history:          Record<string, ConversationMessage[]>
  pending:          Record<string, string>
  pendingReasoning: Record<string, string>
  pendingBatch:     Record<string, PendingBatch>
  tools:            ToolCollection
  spanHandles:      Record<string, SpanHandles>
  sessionUsage:     Record<string, TokenUsage>
  pendingUsage:     Record<string, TokenUsage>
  modelInfo:        ModelInfo | null
  requestMap:       Record<string, string>            // requestId -> clientId
  llmRequests:      Record<string, PendingLlmRequest> // requestId -> context for tool calls
}

// ─── Options ───

export type ChatbotActorOptions = {
  llmRef: ActorRef<LlmProviderMsg>
  model: string
  systemPrompt?: string
}

// ─── Actor definition ───

export const createChatbotActor = (options: ChatbotActorOptions): ActorDef<ChatbotMsg, ChatbotState> => {
  const { llmRef, model, systemPrompt } = options

  return {
    lifecycle: onLifecycle({
      async start(state, context) {
        context.subscribe(WsMessageTopic, (e) => ({
          type: 'userMessage' as const,
          clientId: e.clientId,
          text: e.text,
          images: e.images,
          traceId: e.traceId,
          parentSpanId: e.parentSpanId,
        }))

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

    handler: onMessage<ChatbotMsg, ChatbotState>({
      userMessage: (state, message, context) => {
        const { clientId, text, images, traceId, parentSpanId } = message
        const prior = state.history[clientId] ?? []

        let userText = text
        if (images && images.length > 0) {
          const imageNote = images.length === 1
            ? `[Image attached: "${images[0]}"]`
            : `[Images attached: ${images.map(p => `"${p}"`).join(', ')}]`
          userText = text ? `${text}\n\n${imageNote}` : imageNote
        }

        const apiMessages: ApiMessage[] = [
          ...(systemPrompt ? [{ role: 'system' as const, content: systemPrompt }] : []),
          ...prior,
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
            history: { ...state.history, [clientId]: [...prior, { role: 'user', content: userText }] },
            pending: { ...state.pending, [clientId]: '' },
            requestMap: { ...state.requestMap, [requestId]: clientId },
            llmRequests: { ...state.llmRequests, [requestId]: { messagesAtCall: apiMessages, toolCollection: state.tools } },
            spanHandles: { ...state.spanHandles, [clientId]: { requestSpan, llmSpan, toolSpans: {} } },
          },
        }
      },

      _toolRegistered: (state, msg) => ({
        state: { ...state, tools: { ...state.tools, [msg.name]: { schema: msg.schema, ref: msg.ref } } },
      }),

      _toolUnregistered: (state, msg) => {
        const { [msg.name]: _, ...rest } = state.tools
        return { state: { ...state, tools: rest } }
      },

      llmToolCalls: (state, message, context) => {
        const { requestId, calls, usage } = message
        const clientId = state.requestMap[requestId]
        const llmReq = state.llmRequests[requestId]
        if (!clientId || !llmReq) return { state }

        const { [requestId]: _rm, ...restRequestMap } = state.requestMap
        const { [requestId]: _lr, ...restLlmRequests } = state.llmRequests

        const { messagesAtCall, toolCollection } = llmReq
        const priorPending = state.pendingUsage[clientId] ?? { promptTokens: 0, completionTokens: 0 }
        const mergedPending: TokenUsage = usage
          ? { promptTokens: priorPending.promptTokens + usage.promptTokens, completionTokens: priorPending.completionTokens + usage.completionTokens }
          : priorPending
        const handles = state.spanHandles[clientId]

        handles?.llmSpan?.done({ toolCalls: calls.map(c => c.name) })

        const unknownCall = calls.find(c => !toolCollection[c.name])
        if (unknownCall) {
          handles?.requestSpan.error('tool unavailable')
          const { [clientId]: _, ...restHandles } = state.spanHandles
          return {
            state: { ...state, requestMap: restRequestMap, llmRequests: restLlmRequests, spanHandles: restHandles },
            events: [emit(WsSendTopic, {
              clientId,
              text: JSON.stringify({ type: 'error', text: 'Tool unavailable. Please try again.' }),
            })],
          }
        }

        const assistantToolCalls: ToolCall[] = calls.map(c => ({
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: c.arguments },
        }))

        const batch: PendingBatch = { remaining: calls.length, results: [], messagesAtCall, assistantToolCalls }

        const newToolSpans: Record<string, SpanHandle> = {}
        for (const call of calls) {
          const entry = toolCollection[call.name]!
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
            (reply) => ({ type: '_toolResult' as const, clientId, toolName: call.name, toolCallId: call.id, reply }),
            (error) => ({
              type: '_toolResult' as const,
              clientId,
              toolName: call.name,
              toolCallId: call.id,
              reply: { type: 'toolError' as const, error: String(error) },
            }),
          )
        }

        return {
          state: {
            ...state,
            requestMap: restRequestMap,
            llmRequests: restLlmRequests,
            pendingBatch: { ...state.pendingBatch, [clientId]: batch },
            pendingUsage: { ...state.pendingUsage, [clientId]: mergedPending },
            ...(handles ? {
              spanHandles: {
                ...state.spanHandles,
                [clientId]: { ...handles, llmSpan: undefined, toolSpans: newToolSpans },
              },
            } : {}),
          },
          events: [emit(WsSendTopic, { clientId, text: JSON.stringify({ type: 'searching', tools: calls.map(c => c.name) }) })],
        }
      },

      _toolResult: (state, message, context) => {
        const { clientId, toolName, toolCallId, reply } = message
        const batch = state.pendingBatch[clientId]!
        const handles = state.spanHandles[clientId]

        const toolSpan = handles?.toolSpans[toolCallId]
        if (toolSpan) {
          reply.type === 'toolResult' ? toolSpan.done() : toolSpan.error(reply.error)
        }

        const content = reply.type === 'toolResult' ? reply.result : `Tool error: ${reply.error}`
        const sources = reply.type === 'toolResult' ? reply.sources : undefined
        const updatedResults = [...batch.results, { toolCallId, toolName, content }]
        const remaining = batch.remaining - 1

        if (remaining > 0) {
          return {
            state: {
              ...state,
              pendingBatch: { ...state.pendingBatch, [clientId]: { ...batch, remaining, results: updatedResults } },
            },
            events: sources
              ? [emit(WsSendTopic, { clientId, text: JSON.stringify({ type: 'sources', sources }) })]
              : [],
          }
        }

        const { [clientId]: _, ...restBatch } = state.pendingBatch

        const toolResultMsgs: ApiMessage[] = updatedResults.map(r => ({
          role: 'tool', content: r.content, tool_call_id: r.toolCallId,
        }))
        const messagesWithResults: ApiMessage[] = [
          ...batch.messagesAtCall,
          { role: 'assistant', content: null, tool_calls: batch.assistantToolCalls },
          ...toolResultMsgs,
        ]

        const llmSpan = handles
          ? context.trace.child(handles.requestSpan.traceId, handles.requestSpan.spanId, 'llm-response', { model })
          : null

        const requestId = crypto.randomUUID()

        llmRef.send({
          type: 'stream',
          requestId,
          model,
          messages: messagesWithResults,
          tools: undefined,
          replyTo: context.self as unknown as ActorRef<LlmProviderReply>,
        })

        const priorHistory = state.history[clientId] ?? []
        const toolCallHistoryMsg: ConversationMessage = {
          role: 'assistant', content: null, tool_calls: batch.assistantToolCalls,
        }
        const toolResultHistoryMsgs: ConversationMessage[] = updatedResults.map(r => ({
          role: 'tool', content: r.content, tool_call_id: r.toolCallId,
        }))

        const events = sources
          ? [emit(WsSendTopic, { clientId, text: JSON.stringify({ type: 'sources', sources }) })]
          : []

        return {
          state: {
            ...state,
            requestMap: { ...state.requestMap, [requestId]: clientId },
            pendingBatch: restBatch,
            pending: { ...state.pending, [clientId]: '' },
            history: { ...state.history, [clientId]: [...priorHistory, toolCallHistoryMsg, ...toolResultHistoryMsgs] },
            ...(handles ? {
              spanHandles: {
                ...state.spanHandles,
                [clientId]: { ...handles, llmSpan: llmSpan ?? undefined, toolSpans: {} },
              },
            } : {}),
          },
          events,
        }
      },

      llmChunk: (state, message) => {
        const clientId = state.requestMap[message.requestId]
        if (!clientId) return { state }
        const { text } = message
        return {
          state: { ...state, pending: { ...state.pending, [clientId]: (state.pending[clientId] ?? '') + text } },
          events: [emit(WsSendTopic, { clientId, text: JSON.stringify({ type: 'chunk', text }) })],
        }
      },

      llmReasoningChunk: (state, message) => {
        const clientId = state.requestMap[message.requestId]
        if (!clientId) return { state }
        const { text } = message
        return {
          state: { ...state, pendingReasoning: { ...state.pendingReasoning, [clientId]: (state.pendingReasoning[clientId] ?? '') + text } },
          events: [emit(WsSendTopic, { clientId, text: JSON.stringify({ type: 'reasoningChunk', text }) })],
        }
      },

      llmDone: (state, message) => {
        const { requestId, usage } = message
        const clientId = state.requestMap[requestId]
        if (!clientId) return { state }

        const { [requestId]: _, ...restRequestMap } = state.requestMap
        const { [requestId]: _lr, ...restLlmRequests } = state.llmRequests
        const fullReply = state.pending[clientId] ?? ''
        const prior = state.history[clientId] ?? []
        const { [clientId]: _p, ...restPending } = state.pending
        const { [clientId]: _r, ...restReasoning } = state.pendingReasoning
        const { [clientId]: __, ...restHandles } = state.spanHandles
        const { [clientId]: _pu, ...restPendingUsage } = state.pendingUsage
        const handles = state.spanHandles[clientId]
        handles?.llmSpan?.done()
        handles?.requestSpan.done()

        const accumulated = state.pendingUsage[clientId] ?? { promptTokens: 0, completionTokens: 0 }
        const totalUsage: TokenUsage | null = usage
          ? { promptTokens: accumulated.promptTokens + usage.promptTokens, completionTokens: accumulated.completionTokens + usage.completionTokens }
          : (accumulated.promptTokens > 0 ? accumulated : null)

        const prevSession = state.sessionUsage[clientId] ?? { promptTokens: 0, completionTokens: 0 }
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

        const usageEvent = emit(WsSendTopic, {
          clientId,
          text: JSON.stringify({
            type: 'usage',
            model,
            inputTokens: newSession.promptTokens,
            outputTokens: newSession.completionTokens,
            contextWindow: info?.contextWindow ?? null,
            contextPercent,
            sessionCost,
          }),
        })

        return {
          state: {
            ...state,
            requestMap: restRequestMap,
            llmRequests: restLlmRequests,
            history: { ...state.history, [clientId]: [...prior, { role: 'assistant', content: fullReply }] },
            pending: restPending,
            pendingReasoning: restReasoning,
            spanHandles: restHandles,
            pendingUsage: restPendingUsage,
            sessionUsage: { ...state.sessionUsage, [clientId]: newSession },
          },
          events: [
            emit(WsSendTopic, { clientId, text: JSON.stringify({ type: 'done' }) }),
            usageEvent,
          ],
        }
      },

      llmError: (state, message, context) => {
        const { requestId, error } = message
        const clientId = state.requestMap[requestId]
        if (!clientId) {
          context.log.error('LLM stream failed (no client)', { error: String(error) })
          return { state }
        }

        context.log.error('LLM stream failed', { clientId, error: String(error) })
        const { [requestId]: _rm, ...restRequestMap } = state.requestMap
        const { [requestId]: _lr, ...restLlmRequests } = state.llmRequests
        const { [clientId]: _p, ...restPending } = state.pending
        const { [clientId]: _r, ...restReasoning } = state.pendingReasoning
        const { [clientId]: _, ...restHandles } = state.spanHandles
        const handles = state.spanHandles[clientId]
        handles?.llmSpan?.error(error)
        handles?.requestSpan?.error(error)

        return {
          state: {
            ...state,
            requestMap: restRequestMap,
            llmRequests: restLlmRequests,
            pending: restPending,
            pendingReasoning: restReasoning,
            spanHandles: restHandles,
          },
          events: [emit(WsSendTopic, {
            clientId,
            text: JSON.stringify({ type: 'error', text: 'Something went wrong. Please try again.' }),
          })],
        }
      },
    }),

    supervision: { type: 'restart', maxRetries: 3, withinMs: 30_000 },
  }
}
