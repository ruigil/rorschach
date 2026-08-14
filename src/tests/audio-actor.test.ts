import { afterEach, describe, test, expect } from 'bun:test'
import { AgentSystem, ask } from '../system/index.ts'
import { Audio } from '../plugins/tools/audio.ts'
import type { LlmProviderMsg } from '../types/llm.ts'
import type { SCRInvokeMsg, SCRReply } from '../types/scr.ts'
import type { PersistenceMsg, PResult } from '../types/persistence.ts'
import { MockPersistenceActor } from './mock-persistence.ts'

const tick = (ms = 50) => Bun.sleep(ms)

describe('audio actor', () => {
  test('tools_audio_text_to_speech saves audio and returns public url', async () => {
    const system = await AgentSystem()
    
    const persistenceRef = system.spawn('mock-persistence', MockPersistenceActor())

    // Mock LLM Provider
    const llmDef = {
      handler: (state: any, msg: LlmProviderMsg) => {
        if (msg.type === 'speak') {
          const mockAudio = Buffer.from(new Uint8Array(100)).toString('base64')
          msg.replyTo.send({ type: 'llmAudioChunk', requestId: msg.requestId, data: mockAudio, format: msg.format ?? 'mp3' })
          msg.replyTo.send({ type: 'llmDone', requestId: msg.requestId, usage: null })
        }
        return { state }
      }
    }
    const llmRef = system.spawn('llm', llmDef)

    const audioRef = system.spawn('audio', Audio({
      llmRef,
      persistenceRef,
      ttsModel: 'test-tts-model',
      sttModel: 'test-stt-model',
      voice: 'alloy'
    }), { state: { pending: {}, llmRef, persistenceRef } })

    await tick()

    const reply = await ask<SCRInvokeMsg, SCRReply>(
      audioRef,
      (replyTo) => ({
        type: 'invoke',
        urn: 'scr:leaf:tools.audio_text_to_speech',
        input: { text: 'hello world' },
        replyTo,
      }),
      { timeoutMs: 1000 }
    )

    expect(reply.type).toBe('result')
    if (reply.type === 'result') {
      const output = reply.output as { text: string; attachments?: Array<{ kind: string; url: string }> }
      expect(output.text).toContain('Generated speech audio')
      const audioAttachment = output.attachments?.find(a => a.kind === 'audio')
      expect(audioAttachment?.url).toContain('generated/')
    }

    await system.shutdown()
  })

  test('tools_audio_transcribe transcribes an audio file', async () => {
    const system = await AgentSystem()
    
    const persistenceRef = system.spawn('mock-persistence', MockPersistenceActor())

    // Create a minimal valid WAV file (44 bytes header + some silence)
    const header = Buffer.alloc(44)
    header.write('RIFF', 0); header.writeUInt32LE(36 + 8, 4); header.write('WAVE', 8);
    header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22); header.writeUInt32LE(16000, 24); header.writeUInt32LE(32000, 28);
    header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36);
    header.writeUInt32LE(8, 40);
    const dummyData = Buffer.alloc(8)
    const fileBytes = Buffer.concat([header, dummyData])

    // Put file in mock persistence
    await ask<PersistenceMsg, PResult>(persistenceRef, (replyTo) => ({
      type: 'obj.put' as const,
      bucket: 'media',
      key: 'test-transcribe.wav',
      data: new Uint8Array(fileBytes),
      replyTo,
    }))

    const llmDef = {
      handler: (state: any, msg: LlmProviderMsg) => {
        if (msg.type === 'transcribe') {
          msg.replyTo.send({ type: 'llmChunk', requestId: msg.requestId, text: 'The User said: "hello"' })
          msg.replyTo.send({ type: 'llmDone', requestId: msg.requestId, usage: null })
        }
        return { state }
      }
    }
    const llmRef = system.spawn('llm', llmDef)

    const audioRef = system.spawn('audio', Audio({
      llmRef,
      persistenceRef,
      ttsModel: 'test-tts-model',
      sttModel: 'test-stt-model',
      voice: 'alloy'
    }), { state: { pending: {}, llmRef, persistenceRef } })

    await tick()

    const reply = await ask<SCRInvokeMsg, SCRReply>(
      audioRef,
      (replyTo) => ({
        type: 'invoke',
        urn: 'scr:leaf:tools.audio_transcribe',
        input: { audio: 'test-transcribe.wav', format: 'wav' },
        replyTo,
      }),
      { timeoutMs: 2000 }
    )

    expect(reply.type).toBe('result')
    if (reply.type === 'result') {
      const output = reply.output as { text: string }
      expect(output.text).toBe('The User said: "hello"')
    }

    await system.shutdown()
  })
})
