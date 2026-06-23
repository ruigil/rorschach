import type { ActorDef } from '../../system/index.ts'
import { emit } from '../../system/index.ts'
import { onMessage } from '../../system/index.ts'
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import type {
  TokenUsage, 
  VisionProviderReply,
  AudioProviderReply,
  TranscriptionProviderReply,
  SpeechProviderReply,
  ModelInfo,
  VideoSubmitReply,
  VideoPollReply,
  VideoDownloadReply
} from '../../types/llm.ts'
import { CostTopic } from '../../types/llm.ts'
import type { LlmProviderAdapter, LlmProviderInternalMsg, OpenRouterAdapterOptions } from './types.ts'

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'

export const OpenRouterAdapter = (options: OpenRouterAdapterOptions): LlmProviderAdapter => {
  const { apiKey, reasoning } = options
  const modelInfoCache = new Map<string, ModelInfo>()

  async function openRouterStream<T>(
    extraBody: Record<string, unknown>,
    onEvent: (parsed: Record<string, unknown>) => void,
    onDone: (usage: TokenUsage | null) => T,
  ): Promise<T> {
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
      const buf = Buffer.from(await res.arrayBuffer())
      return { data: buf.toString('base64'), format: format ?? 'pcm', usage: null }
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
        const data = await res.json() as { data: Array<{ id: string }> }
        return data.data.map(m => m.id).sort()
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

    downloadVideos: async (downloads) => {
      for (const { url, destPath } of downloads) {
        const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } })
        if (!res.ok) throw new Error(`HTTP ${res.status} downloading video`)
        await mkdir(dirname(destPath), { recursive: true })
        await Bun.write(destPath, res)
      }
    },
  }
}

// ─── Actor definition ───

export type LlmProviderOptions = {
  adapter: LlmProviderAdapter
}

export const LlmProvider = (options: LlmProviderOptions): ActorDef<LlmProviderInternalMsg, null> => {
  const { adapter } = options

  const handleStreamDone = (
    state: null,
    replyTo: { send: (msg: unknown) => void },
    result: { type: string; usage?: TokenUsage | null },
    model: string,
    role: string,
    userId: string | undefined,
    context: { pipeToSelf: (promise: Promise<unknown>, onSuccess: (r: unknown) => unknown, onError: (e: unknown) => unknown) => void },
  ) => {
    replyTo.send(result)
    const usage = result.usage ?? null
    if (usage) {
      context.pipeToSelf(
        adapter.fetchModelInfo(model),
        (info): LlmProviderInternalMsg => ({ type: '_costReady', model, role, userId, usage, info: info as ModelInfo | null }),
        (): LlmProviderInternalMsg => ({ type: '_costReady', model, role, userId, usage, info: null }),
      )
    }
    return { state }
  }

  return {
    initialState: null,
    handler: onMessage<LlmProviderInternalMsg, null>({
      stream: (state, message, context) => {
        const { requestId, model, messages, tools, role, userId, replyTo } = message

        context.pipeToSelf(
          adapter.stream(
            model,
            messages,
            tools,
            (text) => replyTo.send({ type: 'llmChunk', requestId, text }),
            (text) => replyTo.send({ type: 'llmReasoningChunk', requestId, text }),
          ),
          (result): LlmProviderInternalMsg => ({
            type: '_streamDone',
            result: result.type === 'content'
              ? { type: 'llmDone', requestId, usage: result.usage }
              : { type: 'llmToolCalls', requestId, calls: result.calls, usage: result.usage },
            model, role, userId,
            replyTo,
          }),
          (error): LlmProviderInternalMsg => ({
            type: '_streamDone',
            result: { type: 'llmError', requestId, error },
            model, role, userId,
            replyTo,
          }),
        )

        return { state }
      },

      streamImage: (state, message, context) => {
        const { requestId, model, messages, role, userId, replyTo } = message

        context.pipeToSelf(
          adapter.streamImage(
            model,
            messages,
            (text)    => replyTo.send({ type: 'llmChunk',      requestId, text }),
            (dataUrl) => replyTo.send({ type: 'llmImageChunk', requestId, dataUrl }),
          ),
          (result): LlmProviderInternalMsg => ({
            type: '_streamImageDone',
            result: { type: 'llmDone', requestId, usage: result.usage } as VisionProviderReply,
            model, role, userId,
            replyTo,
          }),
          (error): LlmProviderInternalMsg => ({
            type: '_streamImageDone',
            result: { type: 'llmError', requestId, error } as VisionProviderReply,
            model, role, userId,
            replyTo,
          }),
        )

        return { state }
      },

      streamAudio: (state, message, context) => {
        const { requestId, model, messages, voice, role, userId, replyTo } = message

        context.pipeToSelf(
          adapter.streamAudio(
            model,
            messages,
            voice ?? 'alloy',
            (text) => replyTo.send({ type: 'llmChunk',      requestId, text }),
            (data) => replyTo.send({ type: 'llmAudioChunk', requestId, data }),
          ),
          (result): LlmProviderInternalMsg => ({
            type: '_streamAudioDone',
            result: { type: 'llmDone', requestId, usage: result.usage } as AudioProviderReply,
            model, role, userId,
            replyTo,
          }),
          (error): LlmProviderInternalMsg => ({
            type: '_streamAudioDone',
            result: { type: 'llmError', requestId, error } as AudioProviderReply,
            model, role, userId,
            replyTo,
          }),
        )

        return { state }
      },

      speak: (state, message, context) => {
        const { requestId, model, input, voice, instructions, format, role, userId, replyTo } = message
        const fmt = format ?? 'mp3'
        context.log.info('llm speak', { requestId, model, voice, format: fmt })

        context.pipeToSelf(
          adapter.speak(model, input, voice, instructions, fmt),
          ({ data, format: outFormat, usage }): LlmProviderInternalMsg => {
            replyTo.send({ type: 'llmAudioChunk', requestId, data, format: outFormat })
            return {
              type: '_speakDone',
              result: { type: 'llmDone', requestId, usage } as SpeechProviderReply,
              model, role, userId,
              replyTo,
            }
          },
          (error): LlmProviderInternalMsg => ({
            type: '_speakDone',
            result: { type: 'llmError', requestId, error } as SpeechProviderReply,
            model, role, userId,
            replyTo,
          }),
        )

        return { state }
      },

      transcribe: (state, message, context) => {
        const { requestId, model, audio, role, userId, replyTo } = message
        context.log.info('llm transcribe', { requestId, model, format: audio.format })

        context.pipeToSelf(
          adapter.transcribe(model, audio),
          ({ text, usage }): LlmProviderInternalMsg => {
            replyTo.send({ type: 'llmChunk', requestId, text })
            return {
              type: '_transcribeDone',
              result: { type: 'llmDone', requestId, usage } as TranscriptionProviderReply,
              model, role, userId,
              replyTo,
            }
          },
          (error): LlmProviderInternalMsg => ({
            type: '_transcribeDone',
            result: { type: 'llmError', requestId, error } as TranscriptionProviderReply,
            model, role, userId,
            replyTo,
          }),
        )

        return { state }
      },

      embed: (state, message, context) => {
        const { requestId, model, text, dimensions, replyTo } = message
        const role     = 'memory-embed'
        const userId   = message.userId
        context.log.info('llm embed', { requestId, model, dimensions })

        context.pipeToSelf(
          adapter.embed(model, text, dimensions),
          ({ embedding, usage }): LlmProviderInternalMsg => ({ type: '_embedDone', result: { type: 'embeddingResult', embedding }, model, role, userId, usage, replyTo }),
          (error):                LlmProviderInternalMsg => ({ type: '_embedDone', result: { type: 'embeddingError', error: String(error) }, model, role, userId, usage: null, replyTo }),
        )

        return { state }
      },

      _embedDone: (state, message, context) => {
        message.replyTo.send(message.result)
        if (message.usage) {
          context.pipeToSelf(
            adapter.fetchModelInfo(message.model),
            (info): LlmProviderInternalMsg => ({ type: '_costReady', model: message.model, role: message.role, userId: message.userId, usage: message.usage!, info }),
            ():    LlmProviderInternalMsg => ({ type: '_costReady', model: message.model, role: message.role, userId: message.userId, usage: message.usage!, info: null }),
          )
        }
        return { state }
      },

      fetchModelInfo: (state, message, context) => {
        const { model, replyTo } = message

        context.pipeToSelf(
          adapter.fetchModelInfo(model),
          (info): LlmProviderInternalMsg => ({ type: '_modelInfoDone', info, replyTo }),
          (): LlmProviderInternalMsg => ({ type: '_modelInfoDone', info: null, replyTo }),
        )

        return { state }
      },

      fetchModels: (state, message, context) => {
        const { replyTo } = message

        context.pipeToSelf(
          adapter.fetchModels(),
          (models): LlmProviderInternalMsg => ({ type: '_modelsDone', models, replyTo }),
          (): LlmProviderInternalMsg => ({ type: '_modelsDone', models: [], replyTo }),
        )

        return { state }
      },

      rerank: (state, message, context) => {
        const { requestId, model, query, documents, topN, replyTo } = message
        const role     = 'memory-rerank'
        const userId   = message.userId
        context.log.info('llm rerank', { requestId, model, documents: documents.length })

        context.pipeToSelf(
          adapter.rerank(model, query, documents, topN),
          ({ scores, usage }): LlmProviderInternalMsg => ({ type: '_rerankDone', result: { type: 'rerankResult', requestId, scores, usage }, model, role, userId, usage, replyTo }),
          (error):                LlmProviderInternalMsg => ({ type: '_rerankDone', result: { type: 'rerankError', requestId, error: String(error) }, model, role, userId, usage: null, replyTo }),
        )

        return { state }
      },

      submitVideo: (state, message, context) => {
        const { requestId, model, prompt, aspectRatio, duration, resolution, role, userId, replyTo } = message
        context.log.info('llm video submit', { requestId, model })

        context.pipeToSelf(
          adapter.submitVideoGeneration(model, prompt, aspectRatio, duration, resolution),
          (result): LlmProviderInternalMsg => ({
            type: '_videoSubmitDone',
            result: { type: 'videoSubmitted', requestId, jobId: result.jobId, pollingUrl: result.pollingUrl, usage: null } as VideoSubmitReply,
            model, role, userId,
            replyTo,
          }),
          (error): LlmProviderInternalMsg => ({
            type: '_videoSubmitDone',
            result: { type: 'videoSubmitError', requestId, error: String(error) } as VideoSubmitReply,
            model, role, userId,
            replyTo,
          }),
        )

        return { state }
      },

      pollVideo: (state, message, context) => {
        const { requestId, pollingUrl, role, userId, replyTo } = message

        context.pipeToSelf(
          adapter.pollVideoGeneration(pollingUrl),
          (result): LlmProviderInternalMsg => ({
            type: '_videoPollDone',
            result: { type: 'videoPollResult', requestId, status: result.status, unsigned_urls: result.unsigned_urls, error: result.error } as VideoPollReply,
            role, userId,
            replyTo,
          }),
          (error): LlmProviderInternalMsg => ({
            type: '_videoPollDone',
            result: { type: 'videoPollError', requestId, error: String(error) } as VideoPollReply,
            role, userId,
            replyTo,
          }),
        )

        return { state }
      },

      downloadVideos: (state, message, context) => {
        const { requestId, downloads, role, userId, replyTo } = message
        const destPaths = downloads.map(d => d.destPath)
        context.log.info('llm video download', { requestId, count: downloads.length })

        context.pipeToSelf(
          adapter.downloadVideos(downloads),
          (): LlmProviderInternalMsg => ({
            type: '_videoDownloadDone',
            result: { type: 'videosDownloaded', requestId, destPaths } as VideoDownloadReply,
            role, userId,
            replyTo,
          }),
          (error): LlmProviderInternalMsg => ({
            type: '_videoDownloadDone',
            result: { type: 'videoDownloadError', requestId, error: String(error) } as VideoDownloadReply,
            role, userId,
            replyTo,
          }),
        )

        return { state }
      },

      _videoSubmitDone: (state, message) => {
        message.replyTo.send(message.result)
        return { state }
      },

      _videoPollDone: (state, message) => {
        message.replyTo.send(message.result)
        return { state }
      },

      _videoDownloadDone: (state, message) => {
        message.replyTo.send(message.result)
        return { state }
      },

      _rerankDone: (state, message, context) =>
        handleStreamDone(
          state,
          message.replyTo as { send: (msg: unknown) => void },
          message.result as { type: string; usage?: TokenUsage | null },
          message.model,
          message.role,
          message.userId,
          context as { pipeToSelf: (promise: Promise<unknown>, onSuccess: (r: unknown) => unknown, onError: (e: unknown) => unknown) => void },
        ),

      _streamDone: (state, message, context) =>
        handleStreamDone(
          state,
          message.replyTo as { send: (msg: unknown) => void },
          message.result as { type: string; usage?: TokenUsage | null },
          message.model,
          message.role,
          message.userId,
          context as { pipeToSelf: (promise: Promise<unknown>, onSuccess: (r: unknown) => unknown, onError: (e: unknown) => unknown) => void },
        ),

      _streamImageDone: (state, message, context) =>
        handleStreamDone(
          state,
          message.replyTo as { send: (msg: unknown) => void },
          message.result as { type: string; usage?: TokenUsage | null },
          message.model,
          message.role,
          message.userId,
          context as { pipeToSelf: (promise: Promise<unknown>, onSuccess: (r: unknown) => unknown, onError: (e: unknown) => unknown) => void },
        ),

      _streamAudioDone: (state, message, context) =>
        handleStreamDone(
          state,
          message.replyTo as { send: (msg: unknown) => void },
          message.result as { type: string; usage?: TokenUsage | null },
          message.model,
          message.role,
          message.userId,
          context as { pipeToSelf: (promise: Promise<unknown>, onSuccess: (r: unknown) => unknown, onError: (e: unknown) => unknown) => void },
        ),

      _speakDone: (state, message, context) =>
        handleStreamDone(
          state,
          message.replyTo as { send: (msg: unknown) => void },
          message.result as { type: string; usage?: TokenUsage | null },
          message.model,
          message.role,
          message.userId,
          context as { pipeToSelf: (promise: Promise<unknown>, onSuccess: (r: unknown) => unknown, onError: (e: unknown) => unknown) => void },
        ),

      _transcribeDone: (state, message, context) =>
        handleStreamDone(
          state,
          message.replyTo as { send: (msg: unknown) => void },
          message.result as { type: string; usage?: TokenUsage | null },
          message.model,
          message.role,
          message.userId,
          context as { pipeToSelf: (promise: Promise<unknown>, onSuccess: (r: unknown) => unknown, onError: (e: unknown) => unknown) => void },
        ),

      _costReady: (state, message) => {
        const { model, role, userId, usage, info } = message
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
            ...(userId ? { userId } : {}),
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
