import { describe, test, expect } from 'bun:test'
import { createPluginSystem, ask } from '../system/index.ts'
import { createAudioActor } from '../plugins/tools/audio.ts'
import type { LlmProviderMsg } from '../types/llm.ts'
import type { ToolInvokeMsg, ToolReply } from '../types/tools.ts'
import { unlink, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

const tick = (ms = 50) => Bun.sleep(ms)

describe('audio actor', () => {
  test('text_to_speech saves audio and returns public url', async () => {
    const system = await createPluginSystem()
    
    // Mock LLM Provider
    const llmDef = {
      handler: (state: any, msg: LlmProviderMsg) => {
        if (msg.type === 'streamAudio') {
          // Send some mock PCM data (base64 encoded)
          const mockPcm = Buffer.from(new Uint8Array(100)).toString('base64')
          msg.replyTo.send({ type: 'llmAudioChunk', requestId: msg.requestId, data: mockPcm })
          msg.replyTo.send({ type: 'llmDone', requestId: msg.requestId, usage: null })
        }
        return { state }
      }
    }
    const llmRef = system.spawn('llm', llmDef, null)

    const audioRef = system.spawn('audio', createAudioActor({
      llmRef,
      model: 'test-model',
      voice: 'alloy'
    }), { pending: {} })

    await tick()

    const reply = await ask<ToolInvokeMsg, ToolReply>(
      audioRef,
      (replyTo) => ({
        type: 'invoke',
        toolName: 'text_to_speech',
        arguments: JSON.stringify({ text: 'hello world' }),
        replyTo
      }),
      { timeoutMs: 1000 }
    )

    expect(reply.type).toBe('toolResult')
    if (reply.type === 'toolResult') {
      expect(reply.result).toContain('Audio generated')
      expect(reply.result).toContain('generated/')
      
      // Extract path for cleanup
      const match = reply.result.match(/\((generated\/.*\.wav)\)/)
      if (match && match[1]) {
        const filePath = join(import.meta.dir, '../../workspace/media', match[1])
        try { await unlink(filePath) } catch {}
      }
    }

    await system.shutdown()
  })

  test('transcribe_audio transcribes an audio file', async () => {
     // This requires a real (small) wav file since ffmpeg will be called
     const testDir = join(import.meta.dir, '../../workspace/test-audio')
     await mkdir(testDir, { recursive: true })
     const testFile = join(testDir, 'test-transcribe.wav')
     
     // Create a minimal valid WAV file (44 bytes header + some silence)
     const header = Buffer.alloc(44)
     header.write('RIFF', 0); header.writeUInt32LE(36 + 8, 4); header.write('WAVE', 8);
     header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20);
     header.writeUInt16LE(1, 22); header.writeUInt32LE(16000, 24); header.writeUInt32LE(32000, 28);
     header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36);
     header.writeUInt32LE(8, 40);
     const dummyData = Buffer.alloc(8)
     await writeFile(testFile, Buffer.concat([header, dummyData]))

    const system = await createPluginSystem()
    
    const llmDef = {
      handler: (state: any, msg: LlmProviderMsg) => {
        if (msg.type === 'stream') {
          msg.replyTo.send({ type: 'llmChunk', requestId: msg.requestId, text: 'The User said: "hello"' })
          msg.replyTo.send({ type: 'llmDone', requestId: msg.requestId, usage: null })
        }
        return { state }
      }
    }
    const llmRef = system.spawn('llm', llmDef, null)

    const audioRef = system.spawn('audio', createAudioActor({
      llmRef,
      model: 'test-model',
      voice: 'alloy'
    }), { pending: {} })

    await tick()

    const reply = await ask<ToolInvokeMsg, ToolReply>(
      audioRef,
      (replyTo) => ({
        type: 'invoke',
        toolName: 'transcribe_audio',
        arguments: JSON.stringify({ audio: testFile, format: 'wav' }),
        replyTo
      }),
      { timeoutMs: 2000 }
    )

    expect(reply.type).toBe('toolResult')
    if (reply.type === 'toolResult') {
      expect(reply.result).toBe('The User said: "hello"')
    }

    try { await unlink(testFile) } catch {}
    await system.shutdown()
  })
})
