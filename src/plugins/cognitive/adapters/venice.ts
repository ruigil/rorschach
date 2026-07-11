import type {
  TokenUsage,
  ModelInfo,
  ApiMessage,
} from '../../../types/llm.ts'
import type { LlmProviderAdapter, VeniceAdapterOptions } from '../types.ts'
import { ask, type ActorRef } from '../../../system/index.ts'
import type { PersistenceMsg, PResult } from '../../../types/persistence.ts'

export const VeniceAdapter = (options: VeniceAdapterOptions): LlmProviderAdapter => {
  const { apiKey } = options
  const baseUrl = options.baseUrl || 'https://api.venice.ai/api/v1'
  const modelInfoCache = new Map<string, ModelInfo>()

  const getPromptFromMessages = (messages: ApiMessage[]): string => {
    const lastUserMsg = [...messages].reverse().find(m => m.role === 'user')
    if (!lastUserMsg) return ''
    if (typeof lastUserMsg.content === 'string') {
      return lastUserMsg.content
    }
    if (Array.isArray(lastUserMsg.content)) {
      return lastUserMsg.content
        .filter(part => part.type === 'text')
        .map(part => (part as { text: string }).text)
        .join('\n')
    }
    return ''
  }

  const veniceStream = async <T>(
    extraBody: Record<string, unknown>,
    onEvent: (parsed: Record<string, unknown>) => void,
    onDone: (usage: TokenUsage | null) => T,
  ): Promise<T> => {
    const res = await fetch(`${baseUrl}/chat/completions`, {
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
      throw new Error(`Venice ${res.status}: ${body}`)
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

      return veniceStream(
        {
          model,
          messages,
          ...(tools ? { tools, tool_choice: 'auto' } : {}),
        },
        (parsed) => {
          const delta: Record<string, unknown> = (parsed as any).choices?.[0]?.delta ?? {}
          if (delta.content) onChunk(delta.content as string)
          
          const reasoning = delta.reasoning ?? delta.reasoning_content
          if (reasoning) onReasoningChunk(reasoning as string)

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
      const prompt = getPromptFromMessages(messages)
      
      const res = await fetch(`${baseUrl}/image/generate`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          prompt,
          return_binary: false,
        }),
      })

      if (!res.ok) {
        const body = await res.text()
        throw new Error(`Venice image generate ${res.status}: ${body}`)
      }

      const data = await res.json() as { images: string[] }
      const base64 = data.images?.[0]
      if (!base64) {
        throw new Error('No image returned from Venice')
      }

      onImageChunk(`data:image/webp;base64,${base64}`)
      return { type: 'content', usage: null }
    },

    streamAudio: async (model, messages, voice, onChunk, onAudioChunk) => {
      // Venice does not support real-time audio streams via chat completions.
      // Throw unsupported error.
      throw new Error('Real-time audio streaming is not supported by Venice AI adapter')
    },

    speak: async (model, input, voice, instructions, format) => {
      const body: Record<string, unknown> = {
        model,
        input,
        voice,
      }
      if (instructions) body.instructions = instructions
      if (format) body.response_format = format

      const res = await fetch(`${baseUrl}/audio/speech`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      })

      if (!res.ok) {
        const errBody = await res.text()
        throw new Error(`Venice speech ${res.status}: ${errBody}`)
      }

      const contentType = res.headers.get('content-type') || ''
      let outFormat = format ?? 'mp3'
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
      const buffer = Buffer.from(audio.data, 'base64')
      const blob = new Blob([buffer], { type: `audio/${audio.format}` })
      
      const formData = new FormData()
      formData.append('file', blob, `audio.${audio.format}`)
      formData.append('model', model)

      const res = await fetch(`${baseUrl}/audio/transcriptions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
        },
        body: formData,
      })

      if (!res.ok) {
        const body = await res.text()
        throw new Error(`Venice transcribe ${res.status}: ${body}`)
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
        const res = await fetch(`${baseUrl}/models`, {
          headers: { 'Authorization': `Bearer ${apiKey}` },
        })
        if (!res.ok) return null
        const data = await res.json() as {
          data: Array<{
            id: string
            context_length?: number
            model_spec?: {
              availableContextTokens?: number
              pricing?: {
                input?: number | { usd?: number }
                output?: number | { usd?: number }
              }
            }
          }>
        }
        for (const entry of data.data) {
          const contextWindow = entry.model_spec?.availableContextTokens ?? entry.context_length ?? 4096
          
          let promptPer1M = 0
          const inputPricing = entry.model_spec?.pricing?.input
          if (typeof inputPricing === 'number') {
            promptPer1M = inputPricing
          } else if (inputPricing && typeof inputPricing.usd === 'number') {
            promptPer1M = inputPricing.usd
          }

          let completionPer1M = 0
          const outputPricing = entry.model_spec?.pricing?.output
          if (typeof outputPricing === 'number') {
            completionPer1M = outputPricing
          } else if (outputPricing && typeof outputPricing.usd === 'number') {
            completionPer1M = outputPricing.usd
          }

          modelInfoCache.set(entry.id, {
            contextWindow,
            promptPer1M,
            completionPer1M,
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

      const res = await fetch(`${baseUrl}/embeddings`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      })

      if (!res.ok) {
        const body = await res.text()
        throw new Error(`Venice embeddings ${res.status}: ${body}`)
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
        const res = await fetch(`${baseUrl}/models?type=all`, {
          headers: { 'Authorization': `Bearer ${apiKey}` },
        })
        if (!res.ok) return []
        type VeniceModel = { id: string; model_spec?: { name?: string; voices?: string[] } }
        const data = await res.json() as { data: VeniceModel[] }
        return data.data.map(m => {
          const suffix = m.model_spec?.voices ? `|${m.model_spec.voices.join(',')}` : ''
          return `${m.id}|${m.model_spec?.name || m.id}${suffix}`
        }).sort()
      } catch {
        return []
      }
    },

    rerank: async () => {
      throw new Error('Reranking is not supported by Venice AI adapter')
    },

    submitVideoGeneration: async (model, prompt, aspectRatio, duration, resolution) => {
      const body: Record<string, unknown> = { model, prompt }
      if (aspectRatio) body.aspect_ratio = aspectRatio
      if (duration !== undefined) body.duration = duration
      if (resolution) body.resolution = resolution

      const res = await fetch(`${baseUrl}/video/queue`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      })

      if (!res.ok) {
        const body = await res.text()
        throw new Error(`Venice video submit ${res.status}: ${body}`)
      }

      const data = await res.json() as { queue_id: string }
      return { jobId: data.queue_id, pollingUrl: JSON.stringify({ model, queueId: data.queue_id }) }
    },

    pollVideoGeneration: async (pollingUrl) => {
      const { model, queueId } = JSON.parse(pollingUrl) as { model: string; queueId: string }
      
      const res = await fetch(`${baseUrl}/video/retrieve`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ model, queue_id: queueId }),
      })

      if (!res.ok) {
        const body = await res.text()
        throw new Error(`Venice video poll ${res.status}: ${body}`)
      }

      const contentType = res.headers.get('Content-Type') ?? ''
      if (contentType.includes('application/json')) {
        const data = await res.json() as { status: string; error?: string }
        if (data.status === 'PROCESSING') {
          return { status: 'processing' }
        }
        if (data.status === 'FAILED') {
          return { status: 'failed', error: data.error ?? 'Generation failed' }
        }
        // Fallback in case JSON status is returned differently
        return { status: 'processing' }
      }

      // If it returns raw video stream/binary data, it is completed!
      return { status: 'completed', unsigned_urls: [pollingUrl] }
    },

    downloadVideos: async (downloads, bucket, persistenceRef) => {
      for (const { url, key } of downloads) {
        let actualUrl = url
        let requestInit: RequestInit = {
          headers: {
            'Authorization': `Bearer ${apiKey}`,
          }
        }

        if (url.startsWith('{') && url.endsWith('}')) {
          try {
            const { model, queueId } = JSON.parse(url) as { model: string; queueId: string }
            actualUrl = `${baseUrl}/video/retrieve`
            requestInit = {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({ model, queue_id: queueId }),
            }
          } catch {
            // fallback to standard GET if parsing fails
          }
        }

        const res = await fetch(actualUrl, requestInit)
        if (!res.ok) {
          const body = await res.text()
          throw new Error(`HTTP ${res.status} downloading video: ${body}`)
        }

        if (!res.body) throw new Error(`HTTP response has no body to stream for ${actualUrl}`)

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

        // Purge media from Venice servers after downloading is complete
        if (url.startsWith('{') && url.endsWith('}')) {
          try {
            const { model, queueId } = JSON.parse(url) as { model: string; queueId: string }
            await fetch(`${baseUrl}/video/complete`, {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({ model, queue_id: queueId }),
            })
          } catch {
            // ignore complete/cleanup failures
          }
        }
      }
    },
  }
}
