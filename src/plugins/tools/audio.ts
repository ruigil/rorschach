import type { ActorDef, ActorRef } from '../../system/index.ts'
import { onMessage, onLifecycle, ask } from '../../system/index.ts'
import { defineTool } from '../../system/index.ts'
import type { ToolInvokeMsg, ToolReply } from '../../types/tools.ts'
import { LlmProviderTopic, type LlmProviderMsg, type SpeechProviderReply, type TranscriptionProviderReply } from '../../types/llm.ts'
import { PersistenceProviderTopic, type PersistenceMsg, type PResult, type PObjGetPayload } from '../../types/persistence.ts'
import type { AudioMsg, AudioState, AudioOptions } from './types.ts'

// ─── Tool schemas ───

export const transcribeAudioTool = defineTool('transcribe_audio', 'Transcribe an audio file to text. Use when the user attaches or references an audio recording.', {
  type: 'object',
  properties: {
    audio:  { type: 'string', description: 'File path to the audio file (e.g. from [Audio attached: "]).' },
    format: { type: 'string', enum: ['mp3', 'wav', 'aac', 'm4a', 'ogg'], description: 'Audio format of the file.' },
  },
  required: ['audio', 'format'],
})

export const textToSpeechTool = defineTool('text_to_speech', 'Convert text to speech and save it as an audio file. Use when the user asks to speak, say, or read something aloud.', {
  type: 'object',
  properties: {
    text:         { type: 'string', description: 'The text to convert to speech.' },
    instructions: { type: 'string', description: 'Speaking style or tone instructions (e.g. "speak slowly and dramatically"). Derived from the user\'s request.' },
  },
  required: ['text'],
})



const DEFAULT_TTS_FORMAT = 'pcm'

// ─── Helpers ───

// Always convert to 16kHz mono WAV via ffmpeg — handles wav, mp3, aac, m4a, ogg, etc.
const loadAudioAsWavBase64 = async (
  persistenceRef: ActorRef<PersistenceMsg> | null,
  audioPath: string
): Promise<string> => {
  if (!persistenceRef) {
    throw new Error('Persistence provider not ready.')
  }

  const res = await ask<PersistenceMsg, PResult<PObjGetPayload>>(persistenceRef, (replyTo) => ({
    type: 'obj.get' as const,
    bucket: 'media',
    key: audioPath,
    replyTo,
  }))

  if (!res.ok) {
    throw new Error(`Failed to load audio from persistence: ${res.error}`)
  }
  if (!res.data) {
    throw new Error('Failed to load audio from persistence: No data')
  }

  const audioBytes = res.data.data

  const proc = Bun.spawn(
    ['ffmpeg', '-i', 'pipe:0', '-ar', '16000', '-ac', '1', '-f', 'wav', 'pipe:1'],
    { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
  )

  if (proc.stdin) {
    proc.stdin.write(audioBytes)
    proc.stdin.flush()
    proc.stdin.end()
  }

  const output = await new Response(proc.stdout).arrayBuffer()
  const exitCode = await proc.exited
  if (exitCode !== 0) throw new Error(`ffmpeg conversion failed (exit ${exitCode})`)
  return Buffer.from(output).toString('base64')
}

// Wrap raw PCM16 (mono, little-endian) bytes in a WAV header with a placeholder data size so the file is playable in streams
const getWavHeaderPlaceholder = (sampleRate = 24000, channels = 1): Buffer => {
  const header = Buffer.alloc(44)
  const dataSize = 0x7fffffff // Placeholder size for streamed audio data
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + dataSize, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(channels, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * channels * 2, 28)
  header.writeUInt16LE(channels * 2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(dataSize, 40)
  return header
}

// ─── Actor definition ───

export const Audio = (options: AudioOptions): ActorDef<AudioMsg, AudioState> => {
  const { ttsModel, sttModel, voice, ttsFormat = DEFAULT_TTS_FORMAT } = options

  return {
    initialState: () => ({ pending: {}, llmRef: options.llmRef ?? null, persistenceRef: options.persistenceRef ?? null }),
    lifecycle: onLifecycle({
      start: (state, ctx) => {
        ctx.subscribe(LlmProviderTopic, (event) => ({ type: '_llmProvider' as const, ref: event.ref }))
        ctx.subscribe(PersistenceProviderTopic, (event) => ({ type: '_persistenceRef' as const, ref: event.ref }))
        return { state }
      },
    }),
    handler: onMessage<AudioMsg, AudioState>({

      _llmProvider: (state, msg) => {
        return { state: { ...state, llmRef: msg.ref } }
      },

      _persistenceRef: (state, msg) => {
        return { state: { ...state, persistenceRef: msg.ref } }
      },

      invoke: (state, message, context) => {
        const { toolName, arguments: args, replyTo, userId } = message

        if (toolName === textToSpeechTool.name) {
          let text = ''
          const ttsVoice = voice
          let instructions = ''
          try {
            const parsed = JSON.parse(args) as { text: string; instructions?: string }
            text = parsed.text
            if (parsed.instructions) instructions = parsed.instructions
          } catch {
            replyTo.send({ type: 'toolError', error: 'Invalid arguments: expected JSON with text' })
            return { state }
          }

          const requestId = crypto.randomUUID()
          
          context.log.info('audio: starting TTS', { requestId, voice: ttsVoice, textLength: text.length })
          if (!state.llmRef) {
            replyTo.send({ type: 'toolError', error: 'Audio model provider not ready.' })
            return { state }
          }
          if (!state.persistenceRef) {
            replyTo.send({ type: 'toolError', error: 'Persistence provider not ready.' })
            return { state }
          }

          let streamController: ReadableStreamDefaultController<Uint8Array> | null = null
          const audioStream = new ReadableStream<Uint8Array>({
            start(controller) {
              streamController = controller
            }
          })

          const isPcm = ttsFormat === 'pcm'
          const ext = isPcm ? 'wav' : ttsFormat
          const fileKey = `generated/${crypto.randomUUID()}.${ext}`

          if (isPcm) {
            const header = getWavHeaderPlaceholder(24000, 1)
            streamController!.enqueue(new Uint8Array(header))
          }

          context.pipeToSelf(
            ask<PersistenceMsg, PResult>(state.persistenceRef, (replyTo) => ({
              type: 'obj.putStream' as const,
              bucket: 'media',
              key: fileKey,
              stream: audioStream,
              replyTo,
            })),
            (): AudioMsg => ({ type: '_audioSaved', requestId, key: fileKey, spokenText: text, voice: ttsVoice, replyTo }),
            (error): AudioMsg => ({ type: '_audioSaveError', requestId, error: String(error), replyTo })
          )

          state.llmRef.send({
            type: 'speak',
            requestId,
            model: ttsModel,
            input: text,
            voice: ttsVoice,
            instructions: instructions || undefined,
            format: ttsFormat,
            role: 'audio',
            userId: userId,
            replyTo: context.self as unknown as ActorRef<SpeechProviderReply>,
          })
          return {
            state: {
              ...state,
              pending: {
                ...state.pending,
                [requestId]: { kind: 'tts', streamController, audioFormat: ttsFormat, spokenText: text, voice: ttsVoice, replyTo, userId }
              },
            },
          }
        }

        // Default: transcribe_audio
        let audioPath = ''
        let format = 'wav'
        try {
          const parsed = JSON.parse(args) as { audio: string; format: string }
          audioPath = parsed.audio
          format = parsed.format
        } catch {
          replyTo.send({ type: 'toolError', error: 'Invalid arguments: expected JSON with audio and format' })
          return { state }
        }

        const requestId = crypto.randomUUID()
        context.log.info('audio: loading audio for transcription', { requestId, audioPath, format })
        context.pipeToSelf(
          loadAudioAsWavBase64(state.persistenceRef, audioPath),
          (data): AudioMsg => ({ type: '_audioLoaded', requestId, data, format: 'wav', replyTo }),
          (error): AudioMsg => ({ type: '_audioLoadError', requestId, error: String(error), replyTo }),
        )
        return {
          state: {
            ...state,
            pending: { ...state.pending, [requestId]: { kind: 'transcription', accumulated: '', replyTo, userId } },
          },
        }
      },

      _audioLoaded: (state, message, context) => {
        const { requestId, data, format } = message
        const req = state.pending[requestId]
        if (!req) return { state }

        context.log.info('audio: audio loaded, sending to LLM for transcription', { requestId })
        if (!state.llmRef) {
          req.replyTo.send({ type: 'toolError', error: 'Audio model provider not ready.' })
          return { state }
        }
        state.llmRef.send({
          type: 'transcribe',
          requestId,
          model: sttModel,
          audio: { data, format },
          role: 'audio',
          userId: req.userId,
          replyTo: context.self as unknown as ActorRef<TranscriptionProviderReply>,
        })
        return { state }
      },

      _audioLoadError: (state, message, context) => {
        const { requestId, error, replyTo } = message
        const { [requestId]: _, ...rest } = state.pending
        context.log.error('audio: failed to load audio file', { requestId, error })
        replyTo.send({ type: 'toolError', error: `Failed to load audio: ${error}` })
        return { state: { ...state, pending: rest } }
      },

      llmChunk: (state, message) => {
        const req = state.pending[message.requestId]
        if (!req || req.kind !== 'transcription') return { state }
        return {
          state: {
            ...state,
            pending: { ...state.pending, [message.requestId]: { ...req, accumulated: req.accumulated + message.text } },
          },
        }
      },

      llmAudioChunk: (state, message) => {
        const req = state.pending[message.requestId]
        if (!req || req.kind !== 'tts' || !req.streamController) return { state }
        const rawBytes = Buffer.from(message.data, 'base64')
        req.streamController.enqueue(new Uint8Array(rawBytes))
        return { state }
      },

      llmDone: (state, message, context) => {
        const req = state.pending[message.requestId]
        if (!req) return { state }

        if (req.kind === 'transcription') {
          context.log.info('audio: transcription complete', { requestId: message.requestId })
          req.replyTo.send({ type: 'toolResult', result: { text: req.accumulated || '(no transcription)' } })
          const { [message.requestId]: _, ...rest } = state.pending
          return { state: { ...state, pending: rest } }
        }

        // tts — close stream controller
        if (req.kind === 'tts' && req.streamController) {
          try {
            req.streamController.close()
          } catch (e) {
            context.log.error('Failed to close audio stream controller', { error: String(e) })
          }
        }
        return { state }
      },

      llmError: (state, message, context) => {
        const { [message.requestId]: req, ...rest } = state.pending
        if (!req) return { state }
        context.log.error('audio actor llm error', { error: String(message.error) })
        
        if (req.kind === 'tts' && req.streamController) {
          try {
            req.streamController.close()
          } catch {}
        }
        
        req.replyTo.send({ type: 'toolError', error: String(message.error) })
        return { state: { ...state, pending: rest } }
      },

      _audioSaved: (state, message, context) => {
        const { [message.requestId]: _, ...rest } = state.pending
        const { key, voice, replyTo } = message
        context.log.info('audio: audio saved', { requestId: message.requestId, key })
        const text = `Generated speech audio (voice: ${voice}) and delivered it to the user as an attachment`
        replyTo.send({ type: 'toolResult', result: { text, attachments: [{ kind: 'audio', url: key }] } })
        return { state: { ...state, pending: rest } }
      },

      _audioSaveError: (state, message, context) => {
        const { [message.requestId]: _, ...rest } = state.pending
        context.log.error('audio: failed to save TTS output', { error: message.error })
        message.replyTo.send({ type: 'toolError', error: `Failed to save audio: ${message.error}` })
        return { state: { ...state, pending: rest } }
      },
    }),

    supervision: { type: 'restart', maxRetries: 3, withinMs: 30_000 },
  }
}

