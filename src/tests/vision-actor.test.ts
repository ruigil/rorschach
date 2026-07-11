import { describe, expect, test } from 'bun:test'
import { AgentSystem, ask } from '../system/index.ts'
import { Vision } from '../plugins/tools/vision-actor.ts'
import type { LlmProviderMsg } from '../types/llm.ts'
import type { ToolInvokeMsg, ToolReply } from '../types/tools.ts'
import type { PersistenceMsg, PResult } from '../types/persistence.ts'
import { MockPersistenceActor } from './mock-persistence.ts'

const tick = (ms = 50) => Bun.sleep(ms)

describe('vision actor', () => {
  test('generate_image streams image via obj.putStream and returns attachment metadata', async () => {
    const system = await AgentSystem()
    const persistenceRef = system.spawn('mock-persistence', MockPersistenceActor())

    // Mock LLM Provider
    const llmRef = system.spawn('vision-test-llm', {
      handler: (state: null, msg: LlmProviderMsg) => {
        if (msg.type === 'streamImage') {
          const dataUrl = `data:image/png;base64,${Buffer.from('png bytes').toString('base64')}`
          msg.replyTo.send({ type: 'llmImageChunk', requestId: msg.requestId, dataUrl })
          msg.replyTo.send({ type: 'llmDone', requestId: msg.requestId, usage: null })
        }
        return { state }
      },
    })
    
    const visionRef = system.spawn('vision-test', Vision({ llmRef, persistenceRef, model: 'test-model' }), {
      state: { pending: {}, llmRef, persistenceRef }
    })
    await tick()

    const reply = await ask<ToolInvokeMsg, ToolReply>(
      visionRef,
      replyTo => ({
        type: 'invoke',
        toolName: 'generate_image',
        arguments: JSON.stringify({ prompt: 'a small blue square' }),
        replyTo,
        userId: 'test-user',
      }),
      { timeoutMs: 1_000 },
    )

    expect(reply.type).toBe('toolResult')
    if (reply.type === 'toolResult') {
      const attachment = reply.result.attachments?.[0]
      expect(attachment).toMatchObject({
        kind: 'image',
        mimeType: 'image/png',
        alt: 'a small blue square',
      })
      expect(attachment?.url).toMatch(/^generated\/.+\.png$/)
      expect(attachment?.name).toBe(attachment?.url.split('/').pop())
    }

    await system.shutdown()
  })

  test('analyze_image resolves image from persistence store and sends to LLM', async () => {
    const system = await AgentSystem()
    const persistenceRef = system.spawn('mock-persistence', MockPersistenceActor())

    // Populate mock persistence store with a fake image
    const imageBytes = Buffer.from('test-image-bytes')
    await ask<PersistenceMsg, PResult>(persistenceRef, (replyTo) => ({
      type: 'obj.put' as const,
      bucket: 'media',
      key: 'test-folder/image.png',
      data: new Uint8Array(imageBytes),
      replyTo,
    }))

    let receivedUrl = ''
    let receivedPrompt = ''

    // Mock LLM Provider to check parameters received
    const llmRef = system.spawn('vision-test-llm', {
      handler: (state: null, msg: LlmProviderMsg) => {
        if (msg.type === 'stream') {
          const userMsg = msg.messages.find(m => m.role === 'user')
          if (userMsg && Array.isArray(userMsg.content)) {
            const imgContent = userMsg.content.find(c => c.type === 'image_url')
            const textContent = userMsg.content.find(c => c.type === 'text')
            if (imgContent && imgContent.type === 'image_url') {
              receivedUrl = imgContent.image_url.url
            }
            if (textContent && textContent.type === 'text') {
              receivedPrompt = textContent.text
            }
          }
          msg.replyTo.send({ type: 'llmChunk', requestId: msg.requestId, text: 'This is a description.' })
          msg.replyTo.send({ type: 'llmDone', requestId: msg.requestId, usage: null })
        }
        return { state }
      },
    })

    const visionRef = system.spawn('vision-test', Vision({ llmRef, persistenceRef, model: 'test-model' }), {
      state: { pending: {}, llmRef, persistenceRef }
    })
    await tick()

    const reply = await ask<ToolInvokeMsg, ToolReply>(
      visionRef,
      replyTo => ({
        type: 'invoke',
        toolName: 'analyze_image',
        arguments: JSON.stringify({ image_url: 'test-folder/image.png', prompt: 'Is this an image?' }),
        replyTo,
        userId: 'test-user',
      }),
      { timeoutMs: 1_000 },
    )

    expect(reply.type).toBe('toolResult')
    if (reply.type === 'toolResult') {
      expect(reply.result.text).toBe('This is a description.')
    }
    
    // Expect the URL received by LLM to be the base64 encoded data url of 'test-image-bytes'
    const expectedBase64 = `data:image/png;base64,${imageBytes.toString('base64')}`
    expect(receivedUrl).toBe(expectedBase64)
    expect(receivedPrompt).toBe('Is this an image?')

    await system.shutdown()
  })
})
