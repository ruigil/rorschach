import { describe, test, expect } from 'bun:test'
import { AgentSystem } from '../system/index.ts'
import { ConfigActor } from '../plugins/config/manager.ts'
import { SystemConfigUpdateTopic } from '../types/config.ts'
import { ask } from '../system/index.ts'

describe('Config Actor & Routes & Tools', () => {
  test('GET /config/plugins yields correct plugin list joined with health', async () => {
    const system = await AgentSystem()

    const managerRef = system.spawn('manager', ConfigActor())

    system.subscribe(SystemConfigUpdateTopic, (msg) => {
      if (msg.replyTo) {
        msg.replyTo.send({
          success: true,
          message: 'OK',
          details: [
            {
              id: 'mock-plugin',
              version: '1.0.0',
              status: 'active',
              modulePath: './mock.ts',
              health: { status: 'degraded', detail: 'Mock degraded', updatedAt: Date.now() },
            },
          ],
        })
      }
    })

    system.spawn('mock-plugin', {
      initialState: () => ({
        health: { status: 'degraded', detail: 'Mock degraded', updatedAt: Date.now() },
      }),
      handler: (state) => ({ state }),
    })

    await Bun.sleep(20)

    const res = await ask<any, any>(managerRef, (replyTo) => ({
      type: 'http.request',
      request: {
        method: 'GET',
        url: '/config/plugins',
        headers: {},
        body: null,
      },
      identity: null,
      replyTo,
    }))

    expect(res.type).toBe('http.response')
    expect(res.response.status).toBe(200)

    const body = JSON.parse(res.response.body)
    expect(Array.isArray(body)).toBe(true)
    expect(body[0].id).toBe('mock-plugin')

    await system.shutdown()
  })

  test('handles agent tools', async () => {
    const system = await AgentSystem()

    const managerRef = system.spawn('manager', ConfigActor())

    system.subscribe(SystemConfigUpdateTopic, (msg) => {
      if (msg.action === 'add_plugin') {
        msg.replyTo?.send({ success: true, message: 'Plugin analytics added', details: { id: 'analytics' } })
      }
    })

    await Bun.sleep(20)

    const reply = await ask<any, any>(managerRef, (replyTo) => ({
      type: 'tool.invoke',
      toolCallId: 'call-1',
      toolName: 'plugins_load',
      args: { specifier: './analytics.ts' },
      replyTo,
    }))
    expect(reply.type).toBe('toolResult')
    expect(reply.result).toContain('analytics')

    await system.shutdown()
  })

  test('handles request timeouts when subscriber does not reply', async () => {
    const system = await AgentSystem()
    const managerRef = system.spawn('manager', ConfigActor())

    managerRef.send({ type: '_requestTimeout', requestId: 'non-existent' })

    await system.shutdown()
  })
})
