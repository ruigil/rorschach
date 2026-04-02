import { join } from 'node:path'
import { mkdir } from 'node:fs/promises'
import type { ActorDef, ActorRef } from '../../system/types.ts'
import { onLifecycle, onMessage } from '../../system/match.ts'
import { emit } from '../../system/types.ts'
import type { ToolInvokeMsg, ToolReply, ToolSchema } from '../../types/tools.ts'
import type { LlmProviderMsg, ApiMessage, AudioProviderReply, LlmProviderReply, ModelInfo } from '../../types/llm.ts'
import { WsSendTopic } from '../../types/ws.ts'
import { ask } from '../../system/ask.ts'

// ─── Output directory for generated audio ───

const GENERATED_DIR = join(import.meta.dir, '../../public/generated')
const GENERATED_PUBLIC_PREFIX = 'generated'

// ─── Tool schemas ───

export const TRANSCRIBE_AUDIO_TOOL_NAME = 'transcribe_audio'

export const TRANSCRIBE_AUDIO_SCHEMA: ToolSchema = {
  type: 'function',
  function: {
    name: TRANSCRIBE_AUDIO_TOOL_NAME,
    description: 'Transcribe an audio file to text. Use when the user attaches or references an audio recording.',
    parameters: {
      type: 'object',
      properties: {
        audio:  { type: 'string', description: 'File path to the audio file (e.g. from [Audio attached: "..."]).' },
        format: { type: 'string', enum: ['mp3', 'wav', 'aac', 'm4a', 'ogg'], description: 'Audio format of the file.' },
      },
      required: ['audio', 'format'],
    },
  },
}

export const TEXT_TO_SPEECH_TOOL_NAME = 'text_to_speech'

export const TEXT_TO_SPEECH_SCHEMA: ToolSchema = {
  type: 'function',
  function: {
    name: TEXT_TO_SPEECH_TOOL_NAME,
    description: 'Convert text to speech and save it as an audio file. Use when the user asks to speak, say, or read something aloud.',
    parameters: {
      type: 'object',
      properties: {
        text:         { type: 'string', description: 'The text to convert to speech.' },
        voice:        { type: 'string', enum: ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'], description: 'Voice to use. Defaults to alloy.' },
        instructions: { type: 'string', description: 'Speaking style or tone instructions (e.g. "speak slowly and dramatically"). Derived from the user\'s request.' },
      },
      required: ['text'],
    },
  },
}

// ─── Messages ───

export type AudioActorMsg =
  | ToolInvokeMsg
  | AudioProviderReply
  | { type: '_audioLoaded';    requestId: string; data: string; format: string; replyTo: ActorRef<ToolReply> }
  | { type: '_audioLoadError'; requestId: string; error: string; replyTo: ActorRef<ToolReply> }
  | { type: '_audioSaved';     requestId: string; filePath: string; publicUrl: string; replyTo: ActorRef<ToolReply> }
  | { type: '_audioSaveError'; requestId: string; error: string; replyTo: ActorRef<ToolReply> }

// ─── State ───

type TranscriptionPending = {
  kind: 'transcription'
  accumulated: string
  replyTo: ActorRef<ToolReply>
  clientId?: string
}

type TtsPending = {
  kind: 'tts'
  accumulatedPcm: Buffer[]
  replyTo: ActorRef<ToolReply>
  clientId?: string
}

export type AudioState = {
  pending: Record<string, TranscriptionPending | TtsPending>
  modelInfo: ModelInfo | null
}

// ─── Options ───

export type AudioActorOptions = {
  llmRef: ActorRef<LlmProviderMsg>
  model: string
  voice: string
  systemPrompt?: string
}

const DEFAULT_TTS_SYSTEM_PROMPT = 'Transcribe this audio'

// ─── Helpers ───

// Always convert to 16kHz mono WAV via ffmpeg — handles wav, mp3, aac, m4a, ogg, etc.
const loadAudioAsWavBase64 = async (filePath: string): Promise<string> => {
  const proc = Bun.spawn(
    ['ffmpeg', '-i', filePath, '-ar', '16000', '-ac', '1', '-f', 'wav', 'pipe:1'],
    { stdout: 'pipe', stderr: 'pipe' },
  )
  const output = await new Response(proc.stdout).arrayBuffer()
  const exitCode = await proc.exited
  if (exitCode !== 0) throw new Error(`ffmpeg conversion failed (exit ${exitCode})`)
  return Buffer.from(output).toString('base64')
}

// PCM16 is raw 16-bit little-endian mono at 24000 Hz — wrap in WAV to make it playable
const pcm16ToWav = (pcm: Buffer, sampleRate = 24000, channels = 1): Buffer => {
  const header = Buffer.alloc(44)
  const dataSize = pcm.length
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
  return Buffer.concat([header, pcm])
}

const saveAudio = async (accumulatedPcm: Buffer[]): Promise<{ filePath: string; publicUrl: string }> => {
  const pcm = Buffer.concat(accumulatedPcm)
  const name = `${crypto.randomUUID()}.wav`
  await mkdir(GENERATED_DIR, { recursive: true })
  const filePath = join(GENERATED_DIR, name)
  await Bun.write(filePath, pcm16ToWav(pcm))
  return { filePath, publicUrl: `${GENERATED_PUBLIC_PREFIX}/${name}` }
}

// ─── Actor definition ───

export const createAudioActor = (options: AudioActorOptions): ActorDef<AudioActorMsg, AudioState> => {
  const { llmRef, model, voice, systemPrompt = DEFAULT_TTS_SYSTEM_PROMPT } = options

  return {
    handler: onMessage<AudioActorMsg, AudioState>({

      invoke: (state, message, context) => {
        const { toolName, arguments: args, replyTo, clientId } = message

        if (toolName === TEXT_TO_SPEECH_TOOL_NAME) {
          let text = ''
          let ttsVoice = voice
          let instructions = ''
          try {
            const parsed = JSON.parse(args) as { text: string; voice?: string; instructions?: string }
            text = parsed.text
            if (parsed.voice) ttsVoice = parsed.voice
            if (parsed.instructions) instructions = parsed.instructions
          } catch {
            replyTo.send({ type: 'toolError', error: 'Invalid arguments: expected JSON with text' })
            return { state }
          }

          const requestId = crypto.randomUUID()
          const messages: ApiMessage[] = [
            { role: 'system', content: instructions ? `${systemPrompt}\n\n${instructions}` : systemPrompt },
            { role: 'user', content: text },
          ]
          llmRef.send({
            type: 'streamAudio',
            requestId,
            model,
            messages,
            voice: ttsVoice,
            replyTo: context.self as unknown as ActorRef<AudioProviderReply>,
          })
          return {
            state: {
              ...state,
              pending: { ...state.pending, [requestId]: { kind: 'tts', accumulatedPcm: [], replyTo, clientId } },
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
        context.pipeToSelf(
          loadAudioAsWavBase64(audioPath),
          (data): AudioActorMsg => ({ type: '_audioLoaded', requestId, data, format: 'wav', replyTo }),
          (error): AudioActorMsg => ({ type: '_audioLoadError', requestId, error: String(error), replyTo }),
        )
        return {
          state: {
            ...state,
            pending: { ...state.pending, [requestId]: { kind: 'transcription', accumulated: '', replyTo, clientId } },
          },
        }
      },

      _audioLoaded: (state, message, context) => {
        const { requestId, data, format } = message
        const req = state.pending[requestId]
        if (!req) return { state }

        llmRef.send({
          type: 'stream',
          requestId,
          model,
          messages: [
            { role: 'user', content: [
              { type: 'text', text: "Reply with: 'The User said: \"<what the user said>\"'. Nothing Else." },
              { type: 'input_audio', input_audio: { data, format } }
            ] },
          ],
          replyTo: context.self as unknown as ActorRef<LlmProviderReply>,
        })
        return { state }
      },

      _audioLoadError: (state, message) => {
        const { requestId, error, replyTo } = message
        const { [requestId]: _, ...rest } = state.pending
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
        if (!req || req.kind !== 'tts') return { state }
        return {
          state: {
            ...state,
            pending: { ...state.pending, [message.requestId]: { ...req, accumulatedPcm: [...req.accumulatedPcm, Buffer.from(message.data, 'base64')] } },
          },
        }
      },

      llmDone: (state, message, context) => {
        const { [message.requestId]: req, ...rest } = state.pending
        if (!req) return { state }

        const usageEvents = (req.clientId && message.usage)
          ? [emit(WsSendTopic, { clientId: req.clientId, text: JSON.stringify({
              type: 'usage',
              role: 'audio',
              model,
              inputTokens:   message.usage.promptTokens,
              outputTokens:  message.usage.completionTokens,
              contextWindow: state.modelInfo?.contextWindow ?? null,
              cost: state.modelInfo
                ? (message.usage.promptTokens     / 1_000_000 * state.modelInfo.promptPer1M)
                + (message.usage.completionTokens / 1_000_000 * state.modelInfo.completionPer1M)
                : null,
            }) })]
          : []

        if (req.kind === 'transcription') {
          req.replyTo.send({ type: 'toolResult', result: req.accumulated || '(no transcription)' })
          return { state: { ...state, pending: rest }, events: usageEvents }
        }

        // tts — save PCM to WAV
        if (!req.accumulatedPcm.length) {
          context.log.error('audio: TTS completed but no audio data received')
          req.replyTo.send({ type: 'toolError', error: 'No audio data received from model.' })
          return { state: { ...state, pending: rest }, events: usageEvents }
        }

        context.pipeToSelf(
          saveAudio(req.accumulatedPcm),
          (r): AudioActorMsg => ({ type: '_audioSaved',     requestId: message.requestId, filePath: r.filePath, publicUrl: r.publicUrl, replyTo: req.replyTo }),
          (e): AudioActorMsg => ({ type: '_audioSaveError', requestId: message.requestId, error: String(e), replyTo: req.replyTo }),
        )
        return { state: { ...state, pending: rest }, events: usageEvents }
      },

      llmError: (state, message, context) => {
        const { [message.requestId]: req, ...rest } = state.pending
        if (!req) return { state }
        context.log.error('audio actor llm error', { error: String(message.error) })
        req.replyTo.send({ type: 'toolError', error: String(message.error) })
        return { state: { ...state, pending: rest } }
      },

      _audioSaved: (state, message) => {
        const { publicUrl, replyTo } = message
        replyTo.send({ type: 'toolResult', result: `Audio generated. Include this in your reply to the user: ![audio](${publicUrl})` })
        return { state }
      },

      _audioSaveError: (state, message, context) => {
        context.log.error('audio: failed to save TTS output', { error: message.error })
        message.replyTo.send({ type: 'toolError', error: `Failed to save audio: ${message.error}` })
        return { state }
      },
    }),

    lifecycle: onLifecycle({
      start: async (state, _context) => {
        const modelInfo = await ask<LlmProviderMsg, ModelInfo | null>(
          llmRef,
          (replyTo) => ({ type: 'fetchModelInfo', model, replyTo }),
        ).catch(() => null)
        return { state: { ...state, modelInfo } }
      },
    }),

    supervision: { type: 'restart', maxRetries: 3, withinMs: 30_000 },
  }
}
