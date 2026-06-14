import { describe, expect, test } from 'bun:test'
import { unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { AgentSystem, ask } from '../system/index.ts'
import { Vision } from '../plugins/tools/vision-actor.ts'
import type { LlmProviderMsg } from '../types/llm.ts'
import type { ToolInvokeMsg, ToolReply } from '../types/tools.ts'

const tick = (ms = 50) => Bun.sleep(ms)

describe('vision actor', () => {
  test('generate_image returns attachment metadata with public URL, name, and MIME type', async () => {
    const system = await AgentSystem()
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
    const visionRef = system.spawn('vision-test', Vision({ llmRef, model: 'test-model' }))
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
      if (attachment?.url) {
        try { await unlink(join(import.meta.dir, '../../workspace/media', attachment.url)) } catch {}
      }
    }

    await system.shutdown()
  })
})
