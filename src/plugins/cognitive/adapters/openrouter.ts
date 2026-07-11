import type {
  TokenUsage,
  ModelInfo,
} from '../../../types/llm.ts'
import type { LlmProviderAdapter, OpenRouterAdapterOptions } from '../types.ts'
import { ask, type ActorRef } from '../../../system/index.ts'
import type { PersistenceMsg, PResult } from '../../../types/persistence.ts'

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'

export const OpenRouterAdapter = (options: OpenRouterAdapterOptions): LlmProviderAdapter => {
  const { apiKey, reasoning } = options
  const modelInfoCache = new Map<string, ModelInfo>()

  const openRouterStream = async <T>(
    extraBody: Record<string, unknown>,
    onEvent: (parsed: Record<string, unknown>) => void,
    onDone: (usage: TokenUsage | null) => T,
  ): Promise<T> => {
    const res = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ...extraBody,
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
        if (data === '[DONE]') return onDone(lastUsage)

        try {
          const parsed = JSON.parse(data)
          if (parsed.usage) {
            lastUsage = { promptTokens: parsed.usage.prompt_tokens, completionTokens: parsed.usage.completion_tokens }
          }
          onEvent(parsed)
        } catch {
          // ignore malformed SSE lines
        }
      }
    }

    return onDone(lastUsage)
  }

  return {
    stream: async (model, messages, tools, onChunk, onReasoningChunk) => {
      const toolCalls: Record<number, { id: string; name: string; arguments: string }> = {}

      return openRouterStream(
        {
          model,
          messages,
          ...(tools ? { tools, tool_choice: 'auto' } : {}),
          ...(reasoning?.enabled ? { reasoning: { effort: reasoning.effort ?? 'medium' } } : {}),
        },
        (parsed) => {
          const delta: Record<string, unknown> = (parsed as any).choices?.[0]?.delta ?? {}
          if (delta.content) onChunk(delta.content as string)
          if (delta.reasoning) onReasoningChunk(delta.reasoning as string)
          if (delta.tool_calls) {
            for (const tc of delta.tool_calls as Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }>) {
              if (!toolCalls[tc.index]) {
                toolCalls[tc.index] = { id: tc.id ?? '', name: tc.function?.name ?? '', arguments: '' }
              }
              if (tc.function?.arguments) toolCalls[tc.index]!.arguments += tc.function.arguments
            }
          }
        },
        (usage) => {
          const calls = Object.values(toolCalls).filter(tc => tc.name)
          if (calls.length > 0) return { type: 'toolCalls', calls, usage }
          return { type: 'content', usage }
        },
      )
    },

    streamImage: async (model, messages, onChunk, onImageChunk) => {
      return openRouterStream(
        { model, messages, modalities: ['image', 'text'] },
        (parsed) => {
          const delta: Record<string, unknown> = (parsed as any).choices?.[0]?.delta ?? {}
          if (delta.content) onChunk(delta.content as string)
          if (delta.images) {
            for (const img of delta.images as Array<{ image_url: { url: string } }>) {
              onImageChunk(img.image_url.url)
            }
          }
        },
        (usage) => ({ type: 'content', usage }),
      )
    },

    streamAudio: async (model, messages, voice, onChunk, onAudioChunk) => {
      return openRouterStream(
        { model, messages, modalities: ['text', 'audio'], audio: { voice, format: 'pcm16' } },
        (parsed) => {
          const audio: Record<string, unknown> = (parsed as any).choices?.[0]?.delta?.audio ?? {}
          if (audio.data) onAudioChunk(audio.data as string)
          if (audio.transcript) onChunk(audio.transcript as string)
        },
        (usage) => ({ type: 'content', usage }),
      )
    },

    speak: async (model, input, voice, instructions, format) => {
      const body: Record<string, unknown> = { model, input, voice }
      if (instructions) body.instructions = instructions
      const res = await fetch('https://openrouter.ai/api/v1/audio/speech', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const errBody = await res.text()
        throw new Error(`OpenRouter speech ${res.status}: ${errBody}`)
      }

      const contentType = res.headers.get('content-type') || ''
      let outFormat = format ?? 'pcm'
      if (contentType.includes('mpeg') || contentType.includes('mp3')) {
        outFormat = 'mp3'
      } else if (contentType.includes('pcm')) {
        outFormat = 'pcm'
      } else if (contentType.includes('wav')) {
        outFormat = 'wav'
      } else if (contentType.includes('ogg')) {
        outFormat = 'ogg'
      } else if (contentType.includes('aac')) {
        outFormat = 'aac'
      } else if (contentType.includes('flac')) {
        outFormat = 'flac'
      } else if (contentType.includes('opus')) {
        outFormat = 'opus'
      }

      const buf = Buffer.from(await res.arrayBuffer())
      return { data: buf.toString('base64'), format: outFormat, usage: null }
    },

    transcribe: async (model, audio) => {
      const res = await fetch('https://openrouter.ai/api/v1/audio/transcriptions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ model, input_audio: { data: audio.data, format: audio.format } }),
      })
      if (!res.ok) {
        const body = await res.text()
        throw new Error(`OpenRouter transcribe ${res.status}: ${body}`)
      }
      const data = await res.json() as { text: string; usage?: { prompt_tokens: number; completion_tokens: number } }
      const usage: TokenUsage | null = data.usage
        ? { promptTokens: data.usage.prompt_tokens, completionTokens: data.usage.completion_tokens ?? 0 }
        : null
      return { text: data.text ?? '', usage }
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
        const data = await res.json() as { data: Array<{ id: string; name?: string }> }
        return data.data.map(m => `${m.id}|${m.name || m.id}`).sort()
      } catch {
        return []
      }
    },

    rerank: async (model, query, documents, topN) => {
      const body: Record<string, unknown> = { model, query, documents }
      if (topN !== undefined) body.top_n = topN
      const res = await fetch('https://openrouter.ai/api/v1/rerank', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const text = await res.text()
        throw new Error(`OpenRouter rerank ${res.status}: ${text}`)
      }
      const data = await res.json() as {
        results: Array<{ index: number; relevance_score: number }>
        usage?: { prompt_tokens: number; completion_tokens: number }
      }
      const scores = data.results.map(r => ({ index: r.index, score: r.relevance_score }))
      const usage: TokenUsage | null = data.usage
        ? { promptTokens: data.usage.prompt_tokens, completionTokens: data.usage.completion_tokens }
        : null
      return { scores, usage }
    },

    submitVideoGeneration: async (model, prompt, aspectRatio, duration, resolution) => {
      const body: Record<string, unknown> = { model, prompt }
      if (aspectRatio) body.aspect_ratio = aspectRatio
      if (duration !== undefined) body.duration = duration
      if (resolution) body.resolution = resolution

      const res = await fetch('https://openrouter.ai/api/v1/videos', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const body = await res.text()
        throw new Error(`OpenRouter video submit ${res.status}: ${body}`)
      }
      const data = await res.json() as { id: string; polling_url: string }
      return { jobId: data.id, pollingUrl: data.polling_url }
    },

    pollVideoGeneration: async (pollingUrl) => {
      const res = await fetch(pollingUrl, {
        headers: { 'Authorization': `Bearer ${apiKey}` },
      })
      if (!res.ok) {
        const body = await res.text()
        throw new Error(`OpenRouter video poll ${res.status}: ${body}`)
      }
      const data = await res.json() as { status: 'completed' | 'failed' | 'processing'; unsigned_urls?: string[]; error?: string }
      return { status: data.status, unsigned_urls: data.unsigned_urls, error: data.error }
    },

    downloadVideos: async (downloads, bucket, persistenceRef) => {
      for (const { url, key } of downloads) {
        const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } })
        if (!res.ok) throw new Error(`HTTP ${res.status} downloading video`)
        if (!res.body) throw new Error(`HTTP response has no body to stream for ${url}`)

        const uploadRes = await ask<PersistenceMsg, PResult>(persistenceRef, (replyTo) => ({
          type: 'obj.putStream',
          bucket,
          key,
          stream: res.body as ReadableStream<Uint8Array>,
          meta: { contentType: res.headers.get('content-type') || 'video/mp4' },
          replyTo,
        }))

        if (!uploadRes.ok) {
          throw new Error(`Failed to store video in persistence: ${uploadRes.error}`)
        }
      }
    },
  }
}
