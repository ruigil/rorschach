import { emit } from '../../system/types.ts'
import type { ActorDef, ActorResult } from '../../system/types.ts'
import { WsMessageTopic, WsSendTopic } from '../interfaces/http.ts'

// ─── Message protocol ───

type ChatbotMsg =
  | { type: 'user-message'; clientId: string; text: string }
  | { type: 'llm-chunk';    clientId: string; text: string }
  | { type: 'llm-done';     clientId: string }
  | { type: 'llm-err';      clientId: string; error: unknown }

// ─── State ───

type ConversationMessage = { role: 'user' | 'assistant'; content: string }

type ChatbotState = {
  history: Record<string, ConversationMessage[]>
  pending: Record<string, string>  // clientId → accumulated in-flight reply
}

// ─── Options ───

export type ChatbotActorOptions = {
  apiKey: string
  model?: string
  systemPrompt?: string
}

// ─── OpenRouter SSE streaming ───

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'

type ApiMessage = { role: 'system' | 'user' | 'assistant'; content: string }

async function streamLLM(
  apiKey: string,
  model: string,
  messages: ApiMessage[],
  onChunk: (text: string) => void,
): Promise<void> {
  const res = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model, messages, stream: true }),
  })

  if (!res.ok) {
    const body = await res.text()
    throw new Error(`OpenRouter ${res.status}: ${body}`)
  }

  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue
      const data = line.slice(6).trim()
      if (data === '[DONE]') return

      try {
        const parsed = JSON.parse(data) as { choices: Array<{ delta: { content?: string } }> }
        const content = parsed.choices[0]?.delta?.content
        if (content) onChunk(content)
      } catch {
        // ignore malformed SSE lines
      }
    }
  }
}

// ─── Actor definition ───

export const createChatbotActor = (options: ChatbotActorOptions): ActorDef<ChatbotMsg, ChatbotState> => {
  const { apiKey, model = 'openai/gpt-4o-mini', systemPrompt } = options


  return {
    lifecycle: (state, event, context) => {
      if (event.type === 'start') {
        context.subscribe(WsMessageTopic, (e) => ({
          type: 'user-message' as const,
          clientId: e.clientId,
          text: e.text,
        }))
      }
      return { state }
    },

    handler: (state, message, context): ActorResult<ChatbotMsg, ChatbotState> => {
      switch (message.type) {
        case 'user-message': {
          const { clientId, text } = message
          const prior = state.history[clientId] ?? []

          const apiMessages: ApiMessage[] = [
            ...(systemPrompt ? [{ role: 'system' as const, content: systemPrompt }] : []),
            ...prior,
            { role: 'user', content: text },
          ]

          // Capture selfRef so the async stream can send messages back into the mailbox
          const selfRef = context.self
          streamLLM(apiKey, model, apiMessages, (chunk) => {
            selfRef.send({ type: 'llm-chunk', clientId, text: chunk })
          }).then(() => {
            selfRef.send({ type: 'llm-done', clientId })
          }).catch((error) => {
            selfRef.send({ type: 'llm-err', clientId, error })
          })

          return {
            state: {
              ...state,
              history: {
                ...state.history,
                [clientId]: [...prior, { role: 'user', content: text }],
              },
              pending: { ...state.pending, [clientId]: '' },
            },
          }
        }

        case 'llm-chunk': {
          const { clientId, text } = message
          return {
            state: {
              ...state,
              pending: { ...state.pending, [clientId]: (state.pending[clientId] ?? '') + text },
            },
            events: [emit(WsSendTopic, { clientId, text: JSON.stringify({ type: 'chunk', text }) })],
          }
        }

        case 'llm-done': {
          const { clientId } = message
          const fullReply = state.pending[clientId] ?? ''
          const prior = state.history[clientId] ?? []
          const { [clientId]: _, ...restPending } = state.pending

          return {
            state: {
              history: {
                ...state.history,
                [clientId]: [...prior, { role: 'assistant', content: fullReply }],
              },
              pending: restPending,
            },
            events: [emit(WsSendTopic, { clientId, text: JSON.stringify({ type: 'done' }) })],
          }
        }

        case 'llm-err': {
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
        }
      }
    },

    supervision: { type: 'restart', maxRetries: 3, withinMs: 30_000 },
  }
}
