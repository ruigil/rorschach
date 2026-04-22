import { describe, test, expect } from 'bun:test'
import { createPluginSystem, ask } from '../system/index.ts'
import { createMemoryStoreActor, INITIAL_STORE_STATE } from '../plugins/memory/memory-store.ts'
import type { MemoryStoreMsg } from '../types/memory.ts'
import type { ToolInvokeMsg, ToolReply } from '../types/tools.ts'
import { LlmProviderTopic } from '../types/llm.ts'
import type { LlmProviderMsg, LlmProviderReply } from '../types/llm.ts'
import type { ActorRef } from '../system/types.ts'

const tick = (ms = 50) => Bun.sleep(ms)

describe('Memory Store Actor (Supervisor/Worker)', () => {
  test('handles multiple concurrent invoke requests by spawning workers', async () => {
    const system = await createPluginSystem()
    
    // 1. Mock LLM Provider
    const mockLlmDef = {
      handler: (state: any, msg: LlmProviderMsg) => {
        if (msg.type === 'stream') {
          // Delay response to simulate work and allow concurrency
          const text = `Stored memory for: ${msg.messages[1]?.content}`
          setTimeout(() => {
            msg.replyTo.send({
              type: 'llmChunk',
              requestId: msg.requestId,
              text,
            })
            msg.replyTo.send({
              type: 'llmDone',
              requestId: msg.requestId,
              usage: { promptTokens: 10, completionTokens: 10 }
            })
          }, 100)
        }
        return { state }
      }
    }
    const llmRef = system.spawn('mock-llm', mockLlmDef, {})
    system.publishRetained(LlmProviderTopic, 'llm', { ref: llmRef })

    // 2. Spawn Memory Store Supervisor
    const storeRef = system.spawn(
      'memory-store',
      createMemoryStoreActor({ model: 'test-model' }),
      INITIAL_STORE_STATE
    )
    
    await tick(100) // Wait for subscriptions

    // 3. Send two concurrent requests
    const promise1 = ask<ToolInvokeMsg, ToolReply>(
      storeRef as unknown as ActorRef<ToolInvokeMsg>,
      (replyTo) => ({
        type: 'invoke',
        toolName: 'store_memory',
        arguments: JSON.stringify({ content: 'I like apples' }),
        replyTo
      })
    )

    const promise2 = ask<ToolInvokeMsg, ToolReply>(
      storeRef as unknown as ActorRef<ToolInvokeMsg>,
      (replyTo) => ({
        type: 'invoke',
        toolName: 'store_memory',
        arguments: JSON.stringify({ content: 'I like oranges' }),
        replyTo
      })
    )

    const [reply1, reply2] = await Promise.all([promise1, promise2])

    expect(reply1.type).toBe('toolResult')
    expect(reply2.type).toBe('toolResult')
    
    if (reply1.type === 'toolResult') {
      expect(reply1.result).toContain('I like apples')
    }
    if (reply2.type === 'toolResult') {
      expect(reply2.result).toContain('I like oranges')
    }

    await system.shutdown()
  })

  test('reports error when LLM provider is missing', async () => {
    const system = await createPluginSystem()
    
    const storeRef = system.spawn(
      'memory-store',
      createMemoryStoreActor({ model: 'test-model' }),
      INITIAL_STORE_STATE
    )
    
    await tick()

    const reply = await ask<ToolInvokeMsg, ToolReply>(
      storeRef as unknown as ActorRef<ToolInvokeMsg>,
      (replyTo) => ({
        type: 'invoke',
        toolName: 'store_memory',
        arguments: JSON.stringify({ content: 'test' }),
        replyTo
      })
    )

    expect(reply.type).toBe('toolError')
    if (reply.type === 'toolError') {
      expect(reply.error).toBe('Memory not ready')
    }

    await system.shutdown()
  })
})
