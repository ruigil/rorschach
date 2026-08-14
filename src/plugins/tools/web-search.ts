import type { ActorDef, ActorRef, SpanHandle } from '../../system/index.ts'
import { onMessage } from '../../system/index.ts'
import { defineTool } from '../../system/index.ts'
import type { ToolSource } from '../../types/tools.ts'
import type { GroundingItem, SourceInfo, BraveLlmContextResponse, WebSearchMsg, WebSearchActorOptions } from './types.ts'

// ─── Tool schema ───

export const webSearchTool = defineTool('tools_web_search', 'Search the web for current information. Use when the user asks about recent events, live data, or facts you may not know.', {
  type: 'object',
  properties: { query: { type: 'string', description: 'The search query' } },
  required: ['query'],
})

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

export const WebSearch = (options: WebSearchActorOptions): ActorDef<WebSearchMsg, null> => {
  const { apiKey, count = 20 } = options

  return {
    initialState: null,
    handler: onMessage<WebSearchMsg, null>({
      invoke: (state, message, ctx) => {
        const { input, replyTo } = message
        let query = ''
        if (typeof input === 'string') {
          try {
            query = (JSON.parse(input) as { query: string }).query || input
          } catch {
            query = input
          }
        } else if (input && typeof input === 'object' && 'query' in input) {
          query = String((input as { query: unknown }).query ?? '')
        }

        const span = ctx.trace.span('brave-search', { query })

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
        replyTo.send({ type: 'result', output: { text, sources } })
        return { state }
      },

      _err: (state, message, ctx) => {
        const { query, error, replyTo, span } = message
        ctx.log.error('web search failed', { query, error })
        span?.error(error)
        replyTo.send({ type: 'error', error })
        return { state }
      },
    }),

    supervision: { type: 'restart', maxRetries: 3, withinMs: 30_000 },
  }
}
