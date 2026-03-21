import type { ActorDef, ActorRef, SpanHandle } from '../../system/types.ts'
import { onMessage } from '../../system/match.ts'
import type { ToolInvokeMsg, ToolReply, ToolSchema, ToolSource } from './tool.ts'

// ─── Brave API types ───

type GroundingItem = {
  url: string
  title: string
  snippets: string[]
}

type SourceInfo = {
  title: string
  hostname: string
  age: (string | null)[]
}

export type BraveLlmContextResponse = {
  grounding: {
    generic: GroundingItem[]
    poi: unknown | null
    map: unknown[]
  }
  sources: Record<string, SourceInfo>
}

// ─── Tool schema ───

export const WEB_SEARCH_TOOL_NAME = 'web_search'

export const WEB_SEARCH_SCHEMA: ToolSchema = {
  type: 'function',
  function: {
    name: WEB_SEARCH_TOOL_NAME,
    description: 'Search the web for current information. Use when the user asks about recent events, live data, or facts you may not know.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: 'The search query' } },
      required: ['query'],
    },
  },
}

// ─── Internal message protocol ───

export type WebSearchMsg =
  | ToolInvokeMsg
  | { type: '_done'; query: string; result: BraveLlmContextResponse; replyTo: ActorRef<ToolReply>; span: SpanHandle | null }
  | { type: '_err'; query: string; error: string; replyTo: ActorRef<ToolReply>; span: SpanHandle | null }

// ─── Options ───

export type WebSearchActorOptions = {
  apiKey: string
  count?: number
}

// ─── Brave API fetch ───

const BRAVE_LLM_CONTEXT_URL = 'https://api.search.brave.com/res/v1/llm/context'

const fetchWebSearch = async (
  apiKey: string,
  query: string,
  count: number,
): Promise<BraveLlmContextResponse> => {
  const url = new URL(BRAVE_LLM_CONTEXT_URL)
  url.searchParams.set('q', query)
  url.searchParams.set('count', String(count))

  const res = await fetch(url, {
    headers: {
      'Accept': 'application/json',
      'X-Subscription-Token': apiKey,
    },
  })

  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Brave Search ${res.status}: ${body}`)
  }

  return res.json() as Promise<BraveLlmContextResponse>
}

// ─── Result formatting ───

const formatResult = (result: BraveLlmContextResponse): { text: string; sources: ToolSource[] } => {
  const items = result.grounding.generic
  const sources: ToolSource[] = items.map((item) => ({
    title: item.title,
    url: item.url,
    snippet: item.snippets[0] ?? '',
  }))
  const text = items.length === 0
    ? 'No results found.'
    : items.map((item, i) => `[${i + 1}] ${item.title}\n${item.url}\n${item.snippets.join(' ')}`).join('\n\n')
  return { text, sources }
}

// ─── Actor definition ───

export const createWebSearchActor = (options: WebSearchActorOptions): ActorDef<WebSearchMsg, null> => {
  const { apiKey, count = 20 } = options

  return {
    handler: onMessage<WebSearchMsg, null>({
      invoke: (state, message, ctx) => {
        const { arguments: args, replyTo } = message
        let query = ''
        try { query = (JSON.parse(args) as { query: string }).query } catch { query = args }

        const parent = ctx.trace.fromHeaders()
        const span: SpanHandle | null = parent
          ? ctx.trace.child(parent.traceId, parent.spanId, 'brave-search', { query })
          : null

        ctx.pipeToSelf(
          fetchWebSearch(apiKey, query, count),
          (result) => ({ type: '_done' as const, query, result, replyTo, span }),
          (error) => ({ type: '_err' as const, query, error: String(error), replyTo, span }),
        )
        return { state }
      },

      _done: (state, message) => {
        const { result, replyTo, span } = message
        const { text, sources } = formatResult(result)
        span?.done({ resultCount: result.grounding.generic.length })
        replyTo.send({ type: 'toolResult', result: text, sources })
        return { state }
      },

      _err: (state, message, ctx) => {
        const { query, error, replyTo, span } = message
        ctx.log.error('web search failed', { query, error })
        span?.error(error)
        replyTo.send({ type: 'toolError', error })
        return { state }
      },
    }),

    supervision: { type: 'restart', maxRetries: 3, withinMs: 30_000 },
  }
}
