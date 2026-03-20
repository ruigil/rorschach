import type { ActorDef, ActorRef } from '../../system/types.ts'
import { onMessage } from '../../system/match.ts'

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

// ─── Public reply types (imported by callers) ───

export type WebSearchReply =
  | { type: 'searchResult'; query: string; result: BraveLlmContextResponse }
  | { type: 'searchError'; query: string; error: string }

// ─── Internal message protocol ───

export type WebSearchMsg =
  | { type: 'search'; query: string; replyTo: ActorRef<WebSearchReply> }
  | { type: '_done'; query: string; result: BraveLlmContextResponse; replyTo: ActorRef<WebSearchReply> }
  | { type: '_err'; query: string; error: string; replyTo: ActorRef<WebSearchReply> }

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

// ─── Actor definition ───

export const createWebSearchActor = (options: WebSearchActorOptions): ActorDef<WebSearchMsg, null> => {
  const { apiKey, count = 20 } = options

  return {
    handler: onMessage<WebSearchMsg, null>({
      search: (state, message, ctx) => {
        const { query, replyTo } = message
        ctx.pipeToSelf(
          fetchWebSearch(apiKey, query, count),
          (result) => ({ type: '_done' as const, query, result, replyTo }),
          (error) => ({ type: '_err' as const, query, error: String(error), replyTo }),
        )
        return { state }
      },

      _done: (state, message) => {
        const { query, result, replyTo } = message
        replyTo.send({ type: 'searchResult', query, result })
        return { state }
      },

      _err: (state, message, ctx) => {
        const { query, error, replyTo } = message
        ctx.log.error('web search failed', { query, error })
        replyTo.send({ type: 'searchError', query, error })
        return { state }
      },
    }),

    supervision: { type: 'restart', maxRetries: 3, withinMs: 30_000 },
  }
}
