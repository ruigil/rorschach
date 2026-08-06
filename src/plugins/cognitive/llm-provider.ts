import type { ActorDef } from '../../system/index.ts'
import { emit, onMessage, onLifecycle } from '../../system/index.ts'
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
import { CostTopic, LlmProviderTopic } from '../../types/llm.ts'
import type { LlmProviderAdapter, LlmProviderInternalMsg } from './types.ts'
import type { MessageRequest } from '../../system/context/request.ts'

// ─── Actor definition ───

export type LlmProviderOptions = {
  adapter: LlmProviderAdapter
}

export const LlmProvider = (options: LlmProviderOptions): ActorDef<LlmProviderInternalMsg, null> => {
  const { adapter } = options

  const handleStreamDone = (
    state: null,
    replyTo: { send: (msg: unknown, request?: Partial<MessageRequest>) => void },
    result: { type: string; usage?: TokenUsage | null },
    model: string,
    role: string,
    userId: string | undefined,
    request: Partial<MessageRequest>,
    context: { pipeToSelf: (promise: Promise<unknown>, onSuccess: (r: unknown) => unknown, onError: (e: unknown) => unknown) => void },
  ) => {
    replyTo.send(result, request)
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
      'http.request': (state, message, context) => {
        const { request, replyTo } = message
        const url = new URL(request.url, 'http://localhost')
        const path = url.pathname

        if (request.method === 'GET' && path === '/models') {
          context.self.send({
            type: 'fetchModels',
            replyTo: {
              name: 'http:models',
              isAlive: () => true,
              send: (models) => {
                replyTo.send({
                  type: 'http.response',
                  response: {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(models),
                  }
                })
              }
            }
          })
        } else {
          replyTo.send({
            type: 'http.response',
            response: {
              status: 404,
              headers: {},
              body: 'Not Found',
            }
          })
        }
        return { state }
      },

      stream: (state, message, context) => {
        const { requestId, model, messages, tools, role, replyTo } = message
        const request = context.request

        context.pipeToSelf(
          adapter.stream(
            model,
            messages,
            tools,
            (text) => replyTo.send({ type: 'llmChunk', requestId, text }, request),
            (text) => replyTo.send({ type: 'llmReasoningChunk', requestId, text }, request),
          ),
          (result): LlmProviderInternalMsg => ({
            type: '_streamDone',
            result: result.type === 'content'
              ? { type: 'llmDone', requestId, usage: result.usage }
              : { type: 'llmToolCalls', requestId, calls: result.calls, usage: result.usage },
            model, role,
            replyTo,
          }),
          (error): LlmProviderInternalMsg => ({
            type: '_streamDone',
            result: { type: 'llmError', requestId, error },
            model, role,
            replyTo,
          }),
        )

        return { state }
      },

      streamImage: (state, message, context) => {
        const { requestId, model, messages, role, replyTo } = message
        const request = context.request

        context.pipeToSelf(
          adapter.streamImage(
            model,
            messages,
            (text)    => replyTo.send({ type: 'llmChunk',      requestId, text }, request),
            (dataUrl) => replyTo.send({ type: 'llmImageChunk', requestId, dataUrl }, request),
          ),
          (result): LlmProviderInternalMsg => ({
            type: '_streamImageDone',
            result: { type: 'llmDone', requestId, usage: result.usage } as VisionProviderReply,
            model, role,
            replyTo,
          }),
          (error): LlmProviderInternalMsg => ({
            type: '_streamImageDone',
            result: { type: 'llmError', requestId, error } as VisionProviderReply,
            model, role,
            replyTo,
          }),
        )

        return { state }
      },

      streamAudio: (state, message, context) => {
        const { requestId, model, messages, voice, role, replyTo } = message
        const request = context.request

        context.pipeToSelf(
          adapter.streamAudio(
            model,
            messages,
            voice ?? 'alloy',
            (text) => replyTo.send({ type: 'llmChunk',      requestId, text }, request),
            (data) => replyTo.send({ type: 'llmAudioChunk', requestId, data }, request),
          ),
          (result): LlmProviderInternalMsg => ({
            type: '_streamAudioDone',
            result: { type: 'llmDone', requestId, usage: result.usage } as AudioProviderReply,
            model, role,
            replyTo,
          }),
          (error): LlmProviderInternalMsg => ({
            type: '_streamAudioDone',
            result: { type: 'llmError', requestId, error } as AudioProviderReply,
            model, role,
            replyTo,
          }),
        )

        return { state }
      },

      speak: (state, message, context) => {
        const { requestId, model, input, voice, instructions, format, role, replyTo } = message
        const request = context.request
        const fmt = format ?? 'mp3'
        context.log.info('llm speak', { requestId, model, voice, format: fmt })

        context.pipeToSelf(
          adapter.speak(model, input, voice, instructions, fmt),
          ({ data, format: outFormat, usage }): LlmProviderInternalMsg => {
            replyTo.send({ type: 'llmAudioChunk', requestId, data, format: outFormat }, request)
            return {
              type: '_speakDone',
              result: { type: 'llmDone', requestId, usage } as SpeechProviderReply,
              model, role,
              replyTo,
            }
          },
          (error): LlmProviderInternalMsg => ({
            type: '_speakDone',
            result: { type: 'llmError', requestId, error } as SpeechProviderReply,
            model, role,
            replyTo,
          }),
        )

        return { state }
      },

      transcribe: (state, message, context) => {
        const { requestId, model, audio, role, replyTo } = message
        const request = context.request
        context.log.info('llm transcribe', { requestId, model, format: audio.format })

        context.pipeToSelf(
          adapter.transcribe(model, audio),
          ({ text, usage }): LlmProviderInternalMsg => {
            replyTo.send({ type: 'llmChunk', requestId, text }, request)
            return {
              type: '_transcribeDone',
              result: { type: 'llmDone', requestId, usage } as TranscriptionProviderReply,
              model, role,
              replyTo,
            }
          },
          (error): LlmProviderInternalMsg => ({
            type: '_transcribeDone',
            result: { type: 'llmError', requestId, error } as TranscriptionProviderReply,
            model, role,
            replyTo,
          }),
        )

        return { state }
      },

      embed: (state, message, context) => {
        const { requestId, model, text, dimensions, replyTo } = message
        const role     = 'memory-embed'
        context.log.info('llm embed', { requestId, model, dimensions })

        context.pipeToSelf(
          adapter.embed(model, text, dimensions),
          ({ embedding, usage }): LlmProviderInternalMsg => ({ type: '_embedDone', result: { type: 'embeddingResult', embedding }, model, role, usage, replyTo }),
          (error):                LlmProviderInternalMsg => ({ type: '_embedDone', result: { type: 'embeddingError', error: String(error) }, model, role, usage: null, replyTo }),
        )

        return { state }
      },

      _embedDone: (state, message, context) => {
        message.replyTo.send(message.result, context.request)
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
        context.log.info('llm rerank', { requestId, model, documents: documents.length })

        context.pipeToSelf(
          adapter.rerank(model, query, documents, topN),
          ({ scores, usage }): LlmProviderInternalMsg => ({ type: '_rerankDone', result: { type: 'rerankResult', requestId, scores, usage }, model, role, usage, replyTo }),
          (error):                LlmProviderInternalMsg => ({ type: '_rerankDone', result: { type: 'rerankError', requestId, error: String(error) }, model, role, usage: null, replyTo }),
        )

        return { state }
      },

      submitVideo: (state, message, context) => {
        const { requestId, model, prompt, aspectRatio, duration, resolution, role, replyTo } = message
        context.log.info('llm video submit', { requestId, model })

        context.pipeToSelf(
          adapter.submitVideoGeneration(model, prompt, aspectRatio, duration, resolution),
          (result): LlmProviderInternalMsg => ({
            type: '_videoSubmitDone',
            result: { type: 'videoSubmitted', requestId, jobId: result.jobId, pollingUrl: result.pollingUrl, usage: null } as VideoSubmitReply,
            model, role,
            replyTo,
          }),
          (error): LlmProviderInternalMsg => ({
            type: '_videoSubmitDone',
            result: { type: 'videoSubmitError', requestId, error: String(error) } as VideoSubmitReply,
            model, role,
            replyTo,
          }),
        )

        return { state }
      },

      pollVideo: (state, message, context) => {
        const { requestId, pollingUrl, role, replyTo } = message

        context.pipeToSelf(
          adapter.pollVideoGeneration(pollingUrl),
          (result): LlmProviderInternalMsg => ({
            type: '_videoPollDone',
            result: { type: 'videoPollResult', requestId, status: result.status, unsigned_urls: result.unsigned_urls, error: result.error } as VideoPollReply,
            role,
            replyTo,
          }),
          (error): LlmProviderInternalMsg => ({
            type: '_videoPollDone',
            result: { type: 'videoPollError', requestId, error: String(error) } as VideoPollReply,
            role,
            replyTo,
          }),
        )

        return { state }
      },

      downloadVideos: (state, message, context) => {
        const { requestId, downloads, bucket, persistenceRef, role, replyTo } = message
        const keys = downloads.map(d => d.key)
        context.log.info('llm video download', { requestId, count: downloads.length, bucket })

        context.pipeToSelf(
          adapter.downloadVideos(downloads, bucket, persistenceRef),
          (): LlmProviderInternalMsg => ({
            type: '_videoDownloadDone',
            result: { type: 'videosDownloaded', requestId, keys } as VideoDownloadReply,
            role,
            replyTo,
          }),
          (error): LlmProviderInternalMsg => ({
            type: '_videoDownloadDone',
            result: { type: 'videoDownloadError', requestId, error: String(error) } as VideoDownloadReply,
            role,
            replyTo,
          }),
        )

        return { state }
      },

      _videoSubmitDone: (state, message, context) => {
        message.replyTo.send(message.result, context.request)
        return { state }
      },

      _videoPollDone: (state, message, context) => {
        message.replyTo.send(message.result, context.request)
        return { state }
      },

      _videoDownloadDone: (state, message, context) => {
        message.replyTo.send(message.result, context.request)
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
          context.request,
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
          context.request,
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
          context.request,
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
          context.request,
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
          context.request,
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
          context.request,
          context as { pipeToSelf: (promise: Promise<unknown>, onSuccess: (r: unknown) => unknown, onError: (e: unknown) => unknown) => void },
        ),

      _costReady: (state, message, ctx) => {
        const { model, role, usage, info } = message
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
            userId: ctx.request.userId,
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
    lifecycle: onLifecycle({
      start: (state, ctx) => {
        ctx.publishRetained(LlmProviderTopic, 'llm-provider', { ref: ctx.self })
        return { state }
      },
      stopped: (state, ctx) => {
        ctx.deleteRetained(LlmProviderTopic, 'llm-provider', { ref: null })
        return { state }
      },
    }),
  }
}
