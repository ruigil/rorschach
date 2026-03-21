import { emit } from '../../system/types.ts'
import type { ActorDef, ActorRef, SpanHandle } from '../../system/types.ts'
import { ask } from '../../system/ask.ts'
import { onLifecycle, onMessage } from '../../system/match.ts'
import { WsMessageTopic, WsSendTopic } from '../interfaces/http.ts'
import type { ToolCollection, ToolInvokeMsg, ToolReply } from '../tools/tool.ts'
import type { GetToolsMsg } from '../tools/tools.plugin.ts'

// ─── Message protocol ───

type ChatbotMsg =
  | { type: 'userMessage';   clientId: string; text: string; traceId: string; parentSpanId: string }
  | { type: 'llmChunk';      clientId: string; text: string }
  | { type: 'llmDone';       clientId: string }
  | { type: 'llmErr';        clientId: string; error: unknown }
  | { type: '_toolsFetched'; clientId: string; apiMessages: ApiMessage[]; toolCollection: ToolCollection }
  | { type: '_toolBatch';    clientId: string; calls: Array<{ id: string; name: string; arguments: string }>; messagesAtCall: ApiMessage[]; toolCollection: ToolCollection }
  | { type: '_toolResult';   clientId: string; toolName: string; toolCallId: string; reply: ToolReply }

// ─── State ───

type ToolCall = {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

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

type SpanHandles = {
  requestSpan: SpanHandle
  llmSpan?: SpanHandle
  toolSpans: Record<string, SpanHandle>
}

export type ChatbotState = {
  history: Record<string, ConversationMessage[]>
  pending: Record<string, string>
  pendingBatch: Record<string, PendingBatch>
  toolsRef: ActorRef<GetToolsMsg> | null
  spanHandles: Record<string, SpanHandles>
}

// ─── Options ───

export type ChatbotActorOptions = {
  apiKey: string
  model?: string
  systemPrompt?: string
}

// ─── OpenRouter types ───

type ApiMessage =
  | { role: 'system';    content: string }
  | { role: 'user';      content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool';      content: string; tool_call_id: string }

type Tool = {
  type: 'function'
  function: { name: string; description: string; parameters: object }
}

// ─── OpenRouter SSE streaming ───

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'

type LLMStreamResult =
  | { type: 'content' }
  | { type: 'toolCalls'; calls: Array<{ id: string; name: string; arguments: string }> }

const streamLLM = async (
  apiKey: string,
  model: string,
  messages: ApiMessage[],
  tools: Tool[] | undefined,
  onChunk: (text: string) => void,
): Promise<LLMStreamResult> => {
  const res = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages,
      stream: true,
      ...(tools ? { tools, tool_choice: 'auto' } : {}),
    }),
  })

  if (!res.ok) {
    const body = await res.text()
    throw new Error(`OpenRouter ${res.status}: ${body}`)
  }

  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const toolCalls: Record<number, { id: string; name: string; arguments: string }> = {}

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue
      const data = line.slice(6).trim()
      if (data === '[DONE]') {
        const calls = Object.values(toolCalls).filter(tc => tc.name)
        if (calls.length > 0) return { type: 'toolCalls', calls }
        return { type: 'content' }
      }

      try {
        const parsed = JSON.parse(data) as {
          choices: Array<{
            delta: {
              content?: string
              tool_calls?: Array<{
                index: number
                id?: string
                function?: { name?: string; arguments?: string }
              }>
            }
          }>
        }
        const delta = parsed.choices[0]?.delta
        if (delta?.content) onChunk(delta.content)
        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            if (!toolCalls[tc.index]) {
              toolCalls[tc.index] = { id: tc.id ?? '', name: tc.function?.name ?? '', arguments: '' }
            }
            if (tc.function?.arguments) toolCalls[tc.index]!.arguments += tc.function.arguments
          }
        }
      } catch {
        // ignore malformed SSE lines
      }
    }
  }

  const calls = Object.values(toolCalls).filter(tc => tc.name)
  if (calls.length > 0) return { type: 'toolCalls', calls }
  return { type: 'content' }
}

// ─── Actor definition ───

export const createChatbotActor = (options: ChatbotActorOptions): ActorDef<ChatbotMsg, ChatbotState> => {
  const { apiKey, model = 'openai/gpt-4o-mini', systemPrompt } = options

  return {
    lifecycle: onLifecycle({
      start(state, context) {
        context.subscribe(WsMessageTopic, (e) => ({
          type: 'userMessage' as const,
          clientId: e.clientId,
          text: e.text,
          traceId: e.traceId,
          parentSpanId: e.parentSpanId,
        }))

        const toolsRef = context.lookup<GetToolsMsg>('system/tools')
        return { state: { ...state, toolsRef: toolsRef ?? null } }
      },
    }),

    handler: onMessage<ChatbotMsg, ChatbotState>({
      userMessage: (state, message, context) => {
        const { clientId, text, traceId, parentSpanId } = message
        const prior = state.history[clientId] ?? []

        const apiMessages: ApiMessage[] = [
          ...(systemPrompt ? [{ role: 'system' as const, content: systemPrompt }] : []),
          ...prior,
          { role: 'user', content: text },
        ]

        const fetchTools: Promise<ToolCollection> = state.toolsRef
          ? ask<GetToolsMsg, ToolCollection>(state.toolsRef, (replyTo) => ({ type: 'getTools', replyTo }))
          : Promise.resolve({})

        context.pipeToSelf(
          fetchTools,
          (toolCollection) => ({ type: '_toolsFetched' as const, clientId, apiMessages, toolCollection }),
          (error) => ({ type: 'llmErr' as const, clientId, error }),
        )

        const requestSpan = context.trace.child(traceId, parentSpanId, 'chatbot', { preview: text.slice(0, 80) })

        return {
          state: {
            ...state,
            history: { ...state.history, [clientId]: [...prior, { role: 'user', content: text }] },
            pending: { ...state.pending, [clientId]: '' },
            spanHandles: { ...state.spanHandles, [clientId]: { requestSpan, toolSpans: {} } },
          },
        }
      },

      _toolsFetched: (state, message, context) => {
        const { clientId, apiMessages, toolCollection } = message
        const selfRef = context.self
        const handles = state.spanHandles[clientId]

        const llmSpan = handles
          ? context.trace.child(handles.requestSpan.traceId, handles.requestSpan.spanId, 'llm-call', { model })
          : null

        const toolSchemas = Object.values(toolCollection).map(e => e.schema as Tool)
        const tools = toolSchemas.length > 0 ? toolSchemas : undefined

        context.pipeToSelf(
          streamLLM(apiKey, model, apiMessages, tools, (chunk) => {
            selfRef.send({ type: 'llmChunk', clientId, text: chunk })
          }),
          (result) => result.type === 'toolCalls'
            ? { type: '_toolBatch' as const, clientId, calls: result.calls, messagesAtCall: apiMessages, toolCollection }
            : { type: 'llmDone' as const, clientId },
          (error) => ({ type: 'llmErr' as const, clientId, error }),
        )

        return {
          state: handles && llmSpan
            ? { ...state, spanHandles: { ...state.spanHandles, [clientId]: { ...handles, llmSpan } } }
            : state,
        }
      },

      _toolBatch: (state, message, context) => {
        const { clientId, calls, messagesAtCall, toolCollection } = message
        const handles = state.spanHandles[clientId]

        // Close the llm-call span with tool call info
        handles?.llmSpan?.done({ toolCalls: calls.map(c => c.name) })

        const unknownCall = calls.find(c => !toolCollection[c.name])
        if (unknownCall) {
          handles?.requestSpan.error('tool unavailable')
          const { [clientId]: _, ...restHandles } = state.spanHandles
          return {
            state: { ...state, spanHandles: restHandles },
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

        // Create a tool-invoke span for each call and dispatch with trace headers
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
            pendingBatch: { ...state.pendingBatch, [clientId]: batch },
            ...(handles ? {
              spanHandles: {
                ...state.spanHandles,
                [clientId]: { ...handles, llmSpan: undefined, toolSpans: newToolSpans },
              },
            } : {}),
          },
          events: [emit(WsSendTopic, { clientId, text: JSON.stringify({ type: 'searching' }) })],
        }
      },

      _toolResult: (state, message, context) => {
        const { clientId, toolName, toolCallId, reply } = message
        const batch = state.pendingBatch[clientId]!
        const selfRef = context.self
        const handles = state.spanHandles[clientId]

        // Close this tool's span
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

        // Start llm-response span for second LLM call
        const llmSpan = handles
          ? context.trace.child(handles.requestSpan.traceId, handles.requestSpan.spanId, 'llm-response', { model })
          : null

        context.pipeToSelf(
          streamLLM(apiKey, model, messagesWithResults, undefined, (chunk) => {
            selfRef.send({ type: 'llmChunk', clientId, text: chunk })
          }),
          () => ({ type: 'llmDone' as const, clientId }),
          (error) => ({ type: 'llmErr' as const, clientId, error }),
        )

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
        const { clientId, text } = message
        return {
          state: { ...state, pending: { ...state.pending, [clientId]: (state.pending[clientId] ?? '') + text } },
          events: [emit(WsSendTopic, { clientId, text: JSON.stringify({ type: 'chunk', text }) })],
        }
      },

      llmDone: (state, message) => {
        const { clientId } = message
        const fullReply = state.pending[clientId] ?? ''
        const prior = state.history[clientId] ?? []
        const { [clientId]: _, ...restPending } = state.pending
        const { [clientId]: __, ...restHandles } = state.spanHandles
        const handles = state.spanHandles[clientId]
        handles?.llmSpan?.done()
        handles?.requestSpan.done()
        return {
          state: {
            ...state,
            history: { ...state.history, [clientId]: [...prior, { role: 'assistant', content: fullReply }] },
            pending: restPending,
            spanHandles: restHandles,
          },
          events: [emit(WsSendTopic, { clientId, text: JSON.stringify({ type: 'done' }) })],
        }
      },

      llmErr: (state, message, context) => {
        const { clientId, error } = message
        context.log.error('LLM stream failed', { clientId, error: String(error) })
        const { [clientId]: _, ...restPending } = state.pending
        const { [clientId]: __, ...restHandles } = state.spanHandles
        const handles = state.spanHandles[clientId]
        handles?.llmSpan?.error(error)
        handles?.requestSpan?.error(error)
        return {
          state: { ...state, pending: restPending, spanHandles: restHandles },
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
