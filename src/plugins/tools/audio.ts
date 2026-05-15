import { join } from 'node:path'
import { mkdir } from 'node:fs/promises'
import type { ActorDef, ActorRef } from '../../system/types.ts'
import { onMessage } from '../../system/match.ts'
import { defineTool } from '../../types/tools.ts'
import type { ToolInvokeMsg, ToolReply } from '../../types/tools.ts'
import type { LlmProviderMsg, SpeechProviderReply, TranscriptionProviderReply } from '../../types/llm.ts'

// ─── Output directory for generated audio ───

const GENERATED_DIR = join(import.meta.dir, '../../..', 'workspace/media/generated')
const GENERATED_PUBLIC_PREFIX = 'generated'

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
    voice:        { type: 'string', enum: ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'], description: 'Voice to use. Defaults to alloy.' },
    instructions: { type: 'string', description: 'Speaking style or tone instructions (e.g. "speak slowly and dramatically"). Derived from the user\'s request.' },
  },
  required: ['text'],
})



// ─── Messages ───

export type AudioMsg =
  | ToolInvokeMsg
  | TranscriptionProviderReply
  | SpeechProviderReply
  | { type: '_audioLoaded';    requestId: string; data: string; format: string; replyTo: ActorRef<ToolReply> }
  | { type: '_audioLoadError'; requestId: string; error: string; replyTo: ActorRef<ToolReply> }
  | { type: '_audioSaved';     requestId: string; filePath: string; publicUrl: string; spokenText: string; voice: string; replyTo: ActorRef<ToolReply> }
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
  audioData: string | null
  audioFormat: string
  spokenText: string
  voice: string
  replyTo: ActorRef<ToolReply>
  clientId?: string
}

export type AudioState = {
  pending: Record<string, TranscriptionPending | TtsPending>
}

// ─── Options ───

export type AudioOptions = {
  llmRef: ActorRef<LlmProviderMsg>
  ttsModel: string
  sttModel: string
  voice: string
  ttsFormat?: string
}

const DEFAULT_TTS_FORMAT = 'pcm'

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

// Wrap raw PCM16 (mono, little-endian) bytes in a WAV header so the file is playable
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

const saveAudio = async (data: string, format: string): Promise<{ filePath: string; publicUrl: string }> => {
  const raw = Buffer.from(data, 'base64')
  const isPcm = format === 'pcm'
  const bytes = isPcm ? pcm16ToWav(raw) : raw
  const ext = isPcm ? 'wav' : format
  const name = `${crypto.randomUUID()}.${ext}`
  await mkdir(GENERATED_DIR, { recursive: true })
  const filePath = join(GENERATED_DIR, name)
  await Bun.write(filePath, bytes)
  return { filePath, publicUrl: `${GENERATED_PUBLIC_PREFIX}/${name}` }
}

// ─── Actor definition ───

export const Audio = (options: AudioOptions): ActorDef<AudioMsg, AudioState> => {
  const { llmRef, ttsModel, sttModel, voice, ttsFormat = DEFAULT_TTS_FORMAT } = options

  return {
    initialState: { pending: {} },
    handler: onMessage<AudioMsg, AudioState>({

      invoke: (state, message, context) => {
        const { toolName, arguments: args, replyTo, clientId } = message

        if (toolName === textToSpeechTool.name) {
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
          
          context.log.info('audio: starting TTS', { requestId, voice: ttsVoice, textLength: text.length })
          llmRef.send({
            type: 'speak',
            requestId,
            model: ttsModel,
            input: text,
            voice: ttsVoice,
            instructions: instructions || undefined,
            format: ttsFormat,
            role: 'audio',
            clientId,
            replyTo: context.self as unknown as ActorRef<SpeechProviderReply>,
          })
          return {
            state: {
              ...state,
              pending: { ...state.pending, [requestId]: { kind: 'tts', audioData: null, audioFormat: ttsFormat, spokenText: text, voice: ttsVoice, replyTo, clientId } },
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
          loadAudioAsWavBase64(audioPath),
          (data): AudioMsg => ({ type: '_audioLoaded', requestId, data, format: 'wav', replyTo }),
          (error): AudioMsg => ({ type: '_audioLoadError', requestId, error: String(error), replyTo }),
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

        context.log.info('audio: audio loaded, sending to LLM for transcription', { requestId })
        llmRef.send({
          type: 'transcribe',
          requestId,
          model: sttModel,
          audio: { data, format },
          role: 'audio',
          clientId: req.clientId,
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
        if (!req || req.kind !== 'tts') return { state }
        return {
          state: {
            ...state,
            pending: { ...state.pending, [message.requestId]: { ...req, audioData: message.data, audioFormat: message.format } },
          },
        }
      },

      llmDone: (state, message, context) => {
        const { [message.requestId]: req, ...rest } = state.pending
        if (!req) return { state }

        if (req.kind === 'transcription') {
          context.log.info('audio: transcription complete', { requestId: message.requestId })
          req.replyTo.send({ type: 'toolResult', result: { text: req.accumulated || '(no transcription)' } })
          return { state: { ...state, pending: rest } }
        }

        // tts — save audio bytes to file
        if (!req.audioData) {
          context.log.error('audio: TTS completed but no audio data received')
          req.replyTo.send({ type: 'toolError', error: 'No audio data received from model.' })
          return { state: { ...state, pending: rest } }
        }

        context.log.info('audio: TTS complete, saving audio', { requestId: message.requestId, format: req.audioFormat })
        context.pipeToSelf(
          saveAudio(req.audioData, req.audioFormat),
          (r): AudioMsg => ({ type: '_audioSaved',     requestId: message.requestId, filePath: r.filePath, publicUrl: r.publicUrl, spokenText: req.spokenText, voice: req.voice, replyTo: req.replyTo }),
          (e): AudioMsg => ({ type: '_audioSaveError', requestId: message.requestId, error: String(e), replyTo: req.replyTo }),
        )
        return { state: { ...state, pending: rest } }
      },

      llmError: (state, message, context) => {
        const { [message.requestId]: req, ...rest } = state.pending
        if (!req) return { state }
        context.log.error('audio actor llm error', { error: String(message.error) })
        req.replyTo.send({ type: 'toolError', error: String(message.error) })
        return { state: { ...state, pending: rest } }
      },

      _audioSaved: (state, message, context) => {
        const { publicUrl, spokenText, voice, replyTo } = message
        context.log.info('audio: audio saved', { requestId: message.requestId, publicUrl })
        const snippet = spokenText.length > 300 ? `${spokenText.slice(0, 300)}…` : spokenText
        const text = `Generated speech audio (voice: ${voice}) and delivered it to the user as an attachment"`
        replyTo.send({ type: 'toolResult', result: { text, attachments: [{ kind: 'audio', url: publicUrl }] } })
        return { state }
      },

      _audioSaveError: (state, message, context) => {
        context.log.error('audio: failed to save TTS output', { error: message.error })
        message.replyTo.send({ type: 'toolError', error: `Failed to save audio: ${message.error}` })
        return { state }
      },
    }),

    supervision: { type: 'restart', maxRetries: 3, withinMs: 30_000 },
  }
}
