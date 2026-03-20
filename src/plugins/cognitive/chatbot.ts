import { emit } from '../../system/types.ts'
import type { ActorDef, ActorRef } from '../../system/types.ts'
import { onLifecycle, onMessage } from '../../system/match.ts'
import { WsMessageTopic, WsSendTopic } from '../interfaces/http.ts'
import { WebSearchRefTopic } from '../tools/tools.plugin.ts'
import type { BraveLlmContextResponse, WebSearchMsg, WebSearchReply } from '../tools/web-search.ts'

// ─── Message protocol ───

type ChatbotMsg =
  | { type: 'userMessage';  clientId: string; text: string }
  | { type: 'llmChunk';     clientId: string; text: string }
  | { type: 'llmDone';      clientId: string }
  | { type: 'llmErr';       clientId: string; error: unknown }
  | { type: 'webSearchRef'; ref: ActorRef<WebSearchMsg> | null }
  | { type: '_toolCall';    clientId: string; toolCallId: string; toolName: string; toolArguments: string; messagesAtCall: ApiMessage[] }
  | { type: 'searchResult'; clientId: string; query: string; result: BraveLlmContextResponse }
  | { type: 'searchError';  clientId: string; query: string; error: string }

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

type PendingSearch = {
  toolCallId: string
  query: string
  messagesAtCall: ApiMessage[]
}

export type ChatbotState = {
  history:       Record<string, ConversationMessage[]>
  pending:       Record<string, string>
  webSearchRef:  ActorRef<WebSearchMsg> | null
  pendingSearch: Record<string, PendingSearch>
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

// ─── Tool definition ───

const WEB_SEARCH_TOOL: Tool = {
  type: 'function',
  function: {
    name: 'web_search',
    description: 'Search the web for current information. Use when the user asks about recent events, live data, or facts you may not know.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: 'The search query' } },
      required: ['query'],
    },
  },
}

// ─── OpenRouter SSE streaming ───

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'

type LLMStreamResult =
  | { type: 'content' }
  | { type: 'toolCall'; id: string; name: string; arguments: string }

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
        const first = toolCalls[0]
        if (first?.name) return { type: 'toolCall', id: first.id, name: first.name, arguments: first.arguments }
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

  const first = toolCalls[0]
  if (first?.name) return { type: 'toolCall', id: first.id, name: first.name, arguments: first.arguments }
  return { type: 'content' }
}

// ─── Search result formatter ───

const formatSearchResults = (result: BraveLlmContextResponse): string => {
  const items = result.grounding.generic
  if (items.length === 0) return 'No results found.'
  return items
    .map((item, i) => `[${i + 1}] ${item.title}\n${item.url}\n${item.snippets.join(' ')}`)
    .join('\n\n')
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
        }))
        context.subscribe(WebSearchRefTopic, (ref) => ({
          type: 'webSearchRef' as const,
          ref,
        }))

        // Bootstrap: if the tools plugin was already loaded before this actor started,
        // discover the current web-search actor via actor snapshots (topic was already published)
        const wsSnapshot = context.actorSnapshots().find(s => s.name.startsWith('system/tools/web-search-'))
        const webSearchRef = wsSnapshot ? context.lookup<WebSearchMsg>(wsSnapshot.name) ?? null : null

        return { state: { ...state, webSearchRef } }
      },
    }),

    handler: onMessage<ChatbotMsg, ChatbotState>({
      webSearchRef: (state, message) => {
        return { state: { ...state, webSearchRef: message.ref } }
      },

      userMessage: (state, message, context) => {
        const { clientId, text } = message
        const prior = state.history[clientId] ?? []

        const apiMessages: ApiMessage[] = [
          ...(systemPrompt ? [{ role: 'system' as const, content: systemPrompt }] : []),
          ...prior,
          { role: 'user', content: text },
        ]

        const tools = state.webSearchRef ? [WEB_SEARCH_TOOL] : undefined
        const selfRef = context.self

        streamLLM(apiKey, model, apiMessages, tools, (chunk) => {
          selfRef.send({ type: 'llmChunk', clientId, text: chunk })
        }).then((result) => {
          if (result.type === 'toolCall') {
            selfRef.send({
              type: '_toolCall',
              clientId,
              toolCallId: result.id,
              toolName: result.name,
              toolArguments: result.arguments,
              messagesAtCall: apiMessages,
            })
          } else {
            selfRef.send({ type: 'llmDone', clientId })
          }
        }).catch((error) => {
          selfRef.send({ type: 'llmErr', clientId, error })
        })

        return {
          state: {
            ...state,
            history: { ...state.history, [clientId]: [...prior, { role: 'user', content: text }] },
            pending: { ...state.pending, [clientId]: '' },
          },
        }
      },

      _toolCall: (state, message, context) => {
        const { clientId, toolCallId, toolName, toolArguments, messagesAtCall } = message
        let query = ''
        try { query = (JSON.parse(toolArguments) as { query: string }).query } catch { query = toolArguments }

        const webSearchRef = state.webSearchRef
        if (!webSearchRef) {
          const { [clientId]: _, ...restPending } = state.pending
          return {
            state: { ...state, pending: restPending },
            events: [emit(WsSendTopic, {
              clientId,
              text: JSON.stringify({ type: 'error', text: 'Search unavailable. Please try again.' }),
            })],
          }
        }

        const replyTo: ActorRef<WebSearchReply> = {
          name: `${context.self.name}/search-reply`,
          send: (reply) => {
            if (reply.type === 'searchResult') {
              context.self.send({ type: 'searchResult', clientId, query: reply.query, result: reply.result })
            } else {
              context.self.send({ type: 'searchError', clientId, query: reply.query, error: reply.error })
            }
          },
        }

        webSearchRef.send({ type: 'search', query, replyTo })

        return {
          state: {
            ...state,
            pendingSearch: { ...state.pendingSearch, [clientId]: { toolCallId, query, messagesAtCall } },
          },
          events: [emit(WsSendTopic, { clientId, text: JSON.stringify({ type: 'searching' }) })],
        }
      },

      searchResult: (state, message, context) => {
        const { clientId, result } = message
        const ps = state.pendingSearch[clientId]
        if (!ps) return { state }

        const { [clientId]: _, ...restPendingSearch } = state.pendingSearch

        const toolCallMsg: ConversationMessage = {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: ps.toolCallId, type: 'function', function: { name: 'web_search', arguments: JSON.stringify({ query: ps.query }) } }],
        }
        const toolResultMsg: ConversationMessage = {
          role: 'tool',
          content: formatSearchResults(result),
          tool_call_id: ps.toolCallId,
        }

        const priorHistory = state.history[clientId] ?? []
        const messagesWithResult: ApiMessage[] = [
          ...ps.messagesAtCall,
          { role: 'assistant', content: null, tool_calls: toolCallMsg.tool_calls },
          { role: 'tool', content: toolResultMsg.content, tool_call_id: ps.toolCallId },
        ]

        const sources = result.grounding.generic.map((item) => ({
          title: item.title,
          url: item.url,
          snippet: item.snippets[0] ?? '',
        }))

        const selfRef = context.self
        streamLLM(apiKey, model, messagesWithResult, undefined, (chunk) => {
          selfRef.send({ type: 'llmChunk', clientId, text: chunk })
        }).then(() => {
          selfRef.send({ type: 'llmDone', clientId })
        }).catch((error) => {
          selfRef.send({ type: 'llmErr', clientId, error })
        })

        return {
          state: {
            ...state,
            history: { ...state.history, [clientId]: [...priorHistory, toolCallMsg, toolResultMsg] },
            pendingSearch: restPendingSearch,
          },
          events: [emit(WsSendTopic, { clientId, text: JSON.stringify({ type: 'sources', sources }) })],
        }
      },

      searchError: (state, message, context) => {
        const { clientId, query, error } = message
        const ps = state.pendingSearch[clientId]
        if (!ps) return { state }

        const { [clientId]: _, ...restPendingSearch } = state.pendingSearch

        const toolCallMsg: ConversationMessage = {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: ps.toolCallId, type: 'function', function: { name: 'web_search', arguments: JSON.stringify({ query }) } }],
        }
        const toolResultMsg: ConversationMessage = {
          role: 'tool',
          content: `Search failed: ${error}`,
          tool_call_id: ps.toolCallId,
        }

        const priorHistory = state.history[clientId] ?? []
        const messagesWithError: ApiMessage[] = [
          ...ps.messagesAtCall,
          { role: 'assistant', content: null, tool_calls: toolCallMsg.tool_calls },
          { role: 'tool', content: toolResultMsg.content, tool_call_id: ps.toolCallId },
        ]

        const selfRef = context.self
        streamLLM(apiKey, model, messagesWithError, undefined, (chunk) => {
          selfRef.send({ type: 'llmChunk', clientId, text: chunk })
        }).then(() => {
          selfRef.send({ type: 'llmDone', clientId })
        }).catch((error) => {
          selfRef.send({ type: 'llmErr', clientId, error })
        })

        return {
          state: {
            ...state,
            history: { ...state.history, [clientId]: [...priorHistory, toolCallMsg, toolResultMsg] },
            pendingSearch: restPendingSearch,
          },
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
        return {
          state: {
            ...state,
            history: { ...state.history, [clientId]: [...prior, { role: 'assistant', content: fullReply }] },
            pending: restPending,
          },
          events: [emit(WsSendTopic, { clientId, text: JSON.stringify({ type: 'done' }) })],
        }
      },

      llmErr: (state, message, context) => {
        const { clientId, error } = message
        context.log.error('LLM stream failed', { clientId, error: String(error) })
        const { [clientId]: _, ...restPending } = state.pending
        return {
          state: { ...state, pending: restPending },
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
