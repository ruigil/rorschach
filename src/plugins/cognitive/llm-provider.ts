import type { ActorDef } from '../../system/types.ts'
import { emit } from '../../system/types.ts'
import { onMessage } from '../../system/match.ts'
import type {
  TokenUsage, LlmProviderMsg, LlmProviderAdapter, OpenRouterAdapterOptions, VisionProviderReply, AudioProviderReply,
  ModelInfo
} from '../../types/llm.ts'
import { CostTopic } from '../../types/llm.ts'

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'

export const createOpenRouterAdapter = (options: OpenRouterAdapterOptions): LlmProviderAdapter => {
  const { apiKey, reasoning } = options
  const modelInfoCache = new Map<string, ModelInfo>()

  return {
    stream: async (model, messages, tools, onChunk, onReasoningChunk) => {
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
          stream_options: { include_usage: true },
          ...(tools ? { tools, tool_choice: 'auto' } : {}),
          ...(reasoning?.enabled ? { reasoning: { effort: reasoning.effort ?? 'medium' } } : {}),
        }),
      })

      if (!res.ok) {
        const body = await res.text()
        throw new Error(`OpenRouter ${res.status}: ${body}`)
      }

      const reader = res.body!.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let lastUsage: TokenUsage | null = null
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
            if (calls.length > 0) return { type: 'toolCalls', calls, usage: lastUsage }
            return { type: 'content', usage: lastUsage }
          }

          try {
            const parsed = JSON.parse(data) as {
              choices: Array<{
                delta: {
                  content?: string
                  reasoning?: string
                  tool_calls?: Array<{
                    index: number
                    id?: string
                    function?: { name?: string; arguments?: string }
                  }>
                }
              }>
              usage?: { prompt_tokens: number; completion_tokens: number }
            }
            if (parsed.usage) {
              lastUsage = { promptTokens: parsed.usage.prompt_tokens, completionTokens: parsed.usage.completion_tokens }
            }
            const delta = parsed.choices[0]?.delta
            if (delta?.content) onChunk(delta.content)
            if (delta?.reasoning) onReasoningChunk(delta.reasoning)
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
      if (calls.length > 0) return { type: 'toolCalls', calls, usage: lastUsage }
      return { type: 'content', usage: lastUsage }
    },

    streamImage: async (model, messages, onChunk, onImageChunk) => {
      const res = await fetch(OPENROUTER_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          messages,
          modalities: ['image', 'text'],
          stream: true,
          stream_options: { include_usage: true },
        }),
      })

      if (!res.ok) {
        const body = await res.text()
        throw new Error(`OpenRouter ${res.status}: ${body}`)
      }

      const reader = res.body!.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let lastUsage: TokenUsage | null = null

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          const data = line.slice(6).trim()
          if (data === '[DONE]') return { type: 'content', usage: lastUsage }

          try {
            const parsed = JSON.parse(data) as {
              choices: Array<{
                delta: {
                  content?: string
                  images?: Array<{ image_url: { url: string } }>
                }
              }>
              usage?: { prompt_tokens: number; completion_tokens: number }
            }
            if (parsed.usage) {
              lastUsage = { promptTokens: parsed.usage.prompt_tokens, completionTokens: parsed.usage.completion_tokens }
            }
            const delta = parsed.choices[0]?.delta
            if (delta?.content) onChunk(delta.content)
            if (delta?.images) {
              for (const img of delta.images) onImageChunk(img.image_url.url)
            }
          } catch {
            // ignore malformed SSE lines
          }
        }
      }

      return { type: 'content', usage: lastUsage }
    },

    streamAudio: async (model, messages, voice, onChunk, onAudioChunk) => {
      const res = await fetch(OPENROUTER_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          messages,
          modalities: ['text', 'audio'],
          audio: { voice, format: 'pcm16' },
          stream: true,
          stream_options: { include_usage: true },
        }),
      })

      if (!res.ok) {
        const body = await res.text()
        throw new Error(`OpenRouter ${res.status}: ${body}`)
      }

      const reader = res.body!.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let lastUsage: TokenUsage | null = null

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          const data = line.slice(6).trim()
          if (data === '[DONE]') return { type: 'content', usage: lastUsage }

          try {
            const parsed = JSON.parse(data) as {
              choices: Array<{
                delta: {
                  audio?: { data?: string; transcript?: string }
                }
              }>
              usage?: { prompt_tokens: number; completion_tokens: number }
            }
            if (parsed.usage) {
              lastUsage = { promptTokens: parsed.usage.prompt_tokens, completionTokens: parsed.usage.completion_tokens }
            }
            const audio = parsed.choices[0]?.delta?.audio
            if (audio?.data) onAudioChunk(audio.data)
            if (audio?.transcript) onChunk(audio.transcript)
          } catch {
            // ignore malformed SSE lines
          }
        }
      }

      return { type: 'content', usage: lastUsage }
    },

    fetchModelInfo: async (model: string) => {
      if (modelInfoCache.has(model)) return modelInfoCache.get(model)!

      try {
        const res = await fetch('https://openrouter.ai/api/v1/models', {
          headers: { 'Authorization': `Bearer ${apiKey}` },
        })
        if (!res.ok) return null
        const data = await res.json() as {
          data: Array<{ id: string; context_length: number; pricing: { prompt: string; completion: string } }>
        }
        for (const entry of data.data) {
          modelInfoCache.set(entry.id, {
            contextWindow:   entry.context_length,
            promptPer1M:     parseFloat(entry.pricing.prompt)     * 1_000_000,
            completionPer1M: parseFloat(entry.pricing.completion) * 1_000_000,
          })
        }
        return modelInfoCache.get(model) ?? null
      } catch {
        return null
      }
    },

    embed: async (model, text, dimensions?: number) => {
      const body: Record<string, unknown> = { model, input: text }
      if (dimensions !== undefined) body.dimensions = dimensions
      const res = await fetch('https://openrouter.ai/api/v1/embeddings', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const body = await res.text()
        throw new Error(`OpenRouter embeddings ${res.status}: ${body}`)
      }
      const data = await res.json() as { data: Array<{ embedding: number[] }>; usage?: { prompt_tokens: number; total_tokens: number } }
      const embedding = data.data[0]?.embedding
      if (!embedding) throw new Error('No embedding returned')
      const usage: TokenUsage | null = data.usage
        ? { promptTokens: data.usage.prompt_tokens, completionTokens: 0 }
        : null
      return { embedding, usage }
    },

    fetchModels: async () => {
      try {
        const res = await fetch('https://openrouter.ai/api/v1/models', {
          headers: { 'Authorization': `Bearer ${apiKey}` },
        })
        if (!res.ok) return []
        const data = await res.json() as { data: Array<{ id: string }> }
        return data.data.map(m => m.id).sort()
      } catch {
        return []
      }
    },
  }
}

// ─── Actor definition ───

export type LlmProviderActorOptions = {
  adapter: LlmProviderAdapter
}

export const createLlmProviderActor = (options: LlmProviderActorOptions): ActorDef<LlmProviderMsg, null> => {
  const { adapter } = options

  return {
    handler: onMessage<LlmProviderMsg, null>({
      stream: (state, message, context) => {
        const { requestId, model, messages, tools, role, clientId, replyTo } = message

        context.pipeToSelf(
          adapter.stream(
            model,
            messages,
            tools,
            (text) => replyTo.send({ type: 'llmChunk', requestId, text }),
            (text) => replyTo.send({ type: 'llmReasoningChunk', requestId, text }),
          ),
          (result): LlmProviderMsg => ({
            type: '_streamDone',
            result: result.type === 'content'
              ? { type: 'llmDone', requestId, usage: result.usage }
              : { type: 'llmToolCalls', requestId, calls: result.calls, usage: result.usage },
            model, role, clientId,
            replyTo,
          }),
          (error): LlmProviderMsg => ({
            type: '_streamDone',
            result: { type: 'llmError', requestId, error },
            model, role, clientId,
            replyTo,
          }),
        )

        return { state }
      },

      streamImage: (state, message, context) => {
        const { requestId, model, messages, role, clientId, replyTo } = message

        context.pipeToSelf(
          adapter.streamImage(
            model,
            messages,
            (text)    => replyTo.send({ type: 'llmChunk',      requestId, text }),
            (dataUrl) => replyTo.send({ type: 'llmImageChunk', requestId, dataUrl }),
          ),
          (result): LlmProviderMsg => ({
            type: '_streamImageDone',
            result: { type: 'llmDone', requestId, usage: result.usage } as VisionProviderReply,
            model, role, clientId,
            replyTo,
          }),
          (error): LlmProviderMsg => ({
            type: '_streamImageDone',
            result: { type: 'llmError', requestId, error } as VisionProviderReply,
            model, role, clientId,
            replyTo,
          }),
        )

        return { state }
      },

      streamAudio: (state, message, context) => {
        const { requestId, model, messages, voice, role, clientId, replyTo } = message

        context.pipeToSelf(
          adapter.streamAudio(
            model,
            messages,
            voice ?? 'alloy',
            (text) => replyTo.send({ type: 'llmChunk',      requestId, text }),
            (data) => replyTo.send({ type: 'llmAudioChunk', requestId, data }),
          ),
          (result): LlmProviderMsg => ({
            type: '_streamAudioDone',
            result: { type: 'llmDone', requestId, usage: result.usage } as AudioProviderReply,
            model, role, clientId,
            replyTo,
          }),
          (error): LlmProviderMsg => ({
            type: '_streamAudioDone',
            result: { type: 'llmError', requestId, error } as AudioProviderReply,
            model, role, clientId,
            replyTo,
          }),
        )

        return { state }
      },

      embed: (state, message, context) => {
        const { requestId, model, text, dimensions, replyTo } = message
        const role     = 'memory-embed'
        const clientId = message.clientId
        context.log.info('llm embed', { requestId, model, dimensions })

        context.pipeToSelf(
          adapter.embed(model, text, dimensions),
          ({ embedding, usage }): LlmProviderMsg => ({ type: '_embedDone', result: { type: 'embeddingResult', embedding }, model, role, clientId, usage, replyTo }),
          (error):                LlmProviderMsg => ({ type: '_embedDone', result: { type: 'embeddingError', error: String(error) }, model, role, clientId, usage: null, replyTo }),
        )

        return { state }
      },

      _embedDone: (state, message, context) => {
        message.replyTo.send(message.result)
        if (message.usage) {
          context.pipeToSelf(
            adapter.fetchModelInfo(message.model),
            (info): LlmProviderMsg => ({ type: '_costReady', model: message.model, role: message.role, clientId: message.clientId, usage: message.usage!, info }),
            ():    LlmProviderMsg => ({ type: '_costReady', model: message.model, role: message.role, clientId: message.clientId, usage: message.usage!, info: null }),
          )
        }
        return { state }
      },

      fetchModelInfo: (state, message, context) => {
        const { model, replyTo } = message

        context.pipeToSelf(
          adapter.fetchModelInfo(model),
          (info): LlmProviderMsg => ({ type: '_modelInfoDone', info, replyTo }),
          (): LlmProviderMsg => ({ type: '_modelInfoDone', info: null, replyTo }),
        )

        return { state }
      },

      fetchModels: (state, message, context) => {
        const { replyTo } = message

        context.pipeToSelf(
          adapter.fetchModels(),
          (models): LlmProviderMsg => ({ type: '_modelsDone', models, replyTo }),
          (): LlmProviderMsg => ({ type: '_modelsDone', models: [], replyTo }),
        )

        return { state }
      },

      _streamDone: (state, message, context) => {
        message.replyTo.send(message.result)
        const usage = (message.result.type === 'llmDone' || message.result.type === 'llmToolCalls')
          ? message.result.usage
          : null
        if (usage) {
          context.pipeToSelf(
            adapter.fetchModelInfo(message.model),
            (info): LlmProviderMsg => ({ type: '_costReady', model: message.model, role: message.role, clientId: message.clientId, usage: usage!, info }),
            ():    LlmProviderMsg => ({ type: '_costReady', model: message.model, role: message.role, clientId: message.clientId, usage: usage!, info: null }),
          )
        }
        return { state }
      },

      _streamImageDone: (state, message, context) => {
        message.replyTo.send(message.result)
        const usage = message.result.type === 'llmDone' ? message.result.usage : null
        if (usage) {
          context.pipeToSelf(
            adapter.fetchModelInfo(message.model),
            (info): LlmProviderMsg => ({ type: '_costReady', model: message.model, role: message.role, clientId: message.clientId, usage: usage!, info }),
            ():    LlmProviderMsg => ({ type: '_costReady', model: message.model, role: message.role, clientId: message.clientId, usage: usage!, info: null }),
          )
        }
        return { state }
      },

      _streamAudioDone: (state, message, context) => {
        message.replyTo.send(message.result)
        const usage = message.result.type === 'llmDone' ? message.result.usage : null
        if (usage) {
          context.pipeToSelf(
            adapter.fetchModelInfo(message.model),
            (info): LlmProviderMsg => ({ type: '_costReady', model: message.model, role: message.role, clientId: message.clientId, usage: usage!, info }),
            ():    LlmProviderMsg => ({ type: '_costReady', model: message.model, role: message.role, clientId: message.clientId, usage: usage!, info: null }),
          )
        }
        return { state }
      },

      _costReady: (state, message) => {
        const { model, role, clientId, usage, info } = message
        const cost = info
          ? (usage.promptTokens     / 1_000_000 * info.promptPer1M)
          + (usage.completionTokens / 1_000_000 * info.completionPer1M)
          : null
        return {
          state,
          events: [emit(CostTopic, {
            timestamp:    Date.now(),
            role,
            model,
            inputTokens:  usage.promptTokens,
            outputTokens: usage.completionTokens,
            cost,
            ...(clientId ? { clientId } : {}),
          })],
        }
      },

      _modelInfoDone: (state, message) => {
        message.replyTo.send(message.info)
        return { state }
      },

      _modelsDone: (state, message) => {
        message.replyTo.send(message.models)
        return { state }
      },
    }),
  }
}
