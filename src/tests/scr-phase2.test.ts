import { describe, test, expect } from 'bun:test'
import { AgentSystem, invokeSCR, onMessage } from '../system/index.ts'
import type { ActorDef, ActorRef } from '../system/index.ts'
import { SCRRegistrationTopic } from '../types/scr.ts'
import type { SCRDescriptor } from '../types/scr.ts'
import type { ToolMsg } from '../types/tools.ts'

const tick = (ms = 50) => Bun.sleep(ms)

describe('SCR Phase 2: Leaf (Tool) Integration and Membrane Validation', () => {
  test('Direct leaf tool routing and successful execution', async () => {
    const system = await AgentSystem()
    await tick()

    const mockToolActor: ActorDef<ToolMsg, null> = {
      initialState: null,
      handler: onMessage({
        invoke: (state, msg) => {
          const args = JSON.parse(msg.arguments)
          msg.replyTo.send({
            type: 'toolResult',
            result: {
              text: `Hello ${args.name}, you are ${args.age} years old.`
            }
          })
          return { state }
        }
      })
    }

    const mockRef = system.spawn('mock-tool-actor', mockToolActor)
    await tick()

    const descriptor: SCRDescriptor = {
      urn: 'scr:leaf:test.greet',
      kind: 'leaf',
      description: 'Greeter tool',
      schema: {
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            age: { type: 'integer' }
          },
          required: ['name', 'age']
        },
        outputSchema: {
          type: 'object',
          properties: {
            text: { type: 'string' }
          },
          required: ['text']
        }
      },
      target: mockRef,
      meta: {
        schema: {
          type: 'function',
          function: {
            name: 'greet',
            description: 'Greeter tool',
            parameters: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                age: { type: 'integer' }
              },
              required: ['name', 'age']
            }
          }
        }
      }
    }

    system.publish(SCRRegistrationTopic, {
      type: 'register',
      descriptor
    })
    await tick()

    // 1. Success execution
    const reply = await invokeSCR('scr:leaf:test.greet', { name: 'Alice', age: 30 })
    expect(reply.type).toBe('result')
    if (reply.type === 'result') {
      expect((reply.output as any).text).toBe('Hello Alice, you are 30 years old.')
    }

    await system.shutdown()
  })

  test('Input validation membrane rejects incorrect types', async () => {
    const system = await AgentSystem()
    await tick()

    const mockToolActor: ActorDef<ToolMsg, null> = {
      initialState: null,
      handler: onMessage({
        invoke: (state, msg) => {
          msg.replyTo.send({
            type: 'toolResult',
            result: { text: 'ok' }
          })
          return { state }
        }
      })
    }
    const mockRef = system.spawn('mock-tool-actor-val', mockToolActor)
    await tick()

    const descriptor: SCRDescriptor = {
      urn: 'scr:leaf:test.greet',
      kind: 'leaf',
      description: 'Greeter tool',
      schema: {
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            age: { type: 'integer' }
          },
          required: ['name', 'age']
        }
      },
      target: mockRef
    }

    system.publish(SCRRegistrationTopic, {
      type: 'register',
      descriptor
    })
    await tick()

    // Missing age
    const reply1 = await invokeSCR('scr:leaf:test.greet', { name: 'Alice' })
    expect(reply1.type).toBe('error')
    if (reply1.type === 'error') {
      expect(reply1.error).toContain('Input validation failed')
      expect(reply1.error).toContain('Missing required property "age"')
    }

    // Invalid type for name
    const reply2 = await invokeSCR('scr:leaf:test.greet', { name: 123, age: 30 })
    expect(reply2.type).toBe('error')
    if (reply2.type === 'error') {
      expect(reply2.error).toContain('Input validation failed')
      expect(reply2.error).toContain('Expected type "string" at name')
    }

    await system.shutdown()
  })

  test('Output validation membrane rejects incorrect return structures', async () => {
    const system = await AgentSystem()
    await tick()

    const mockToolActor: ActorDef<ToolMsg, null> = {
      initialState: null,
      handler: onMessage({
        invoke: (state, msg) => {
          // Returns text instead of structured object
          msg.replyTo.send({
            type: 'toolResult',
            result: { text: 'Not expected structure' }
          })
          return { state }
        }
      })
    }
    const mockRef = system.spawn('mock-tool-actor-out', mockToolActor)
    await tick()

    const descriptor: SCRDescriptor = {
      urn: 'scr:leaf:test.calc',
      kind: 'leaf',
      description: 'Calculator tool',
      schema: {
        outputSchema: {
          type: 'object',
          properties: {
            resultValue: { type: 'number' }
          },
          required: ['resultValue']
        }
      },
      target: mockRef
    }

    system.publish(SCRRegistrationTopic, {
      type: 'register',
      descriptor
    })
    await tick()

    const reply = await invokeSCR('scr:leaf:test.calc', {})
    expect(reply.type).toBe('error')
    if (reply.type === 'error') {
      expect(reply.error).toContain('Output validation failed')
      expect(reply.error).toContain('Missing required property "resultValue"')
    }

    await system.shutdown()
  })

  test('toolPending status propagation works correctly', async () => {
    const system = await AgentSystem()
    await tick()

    const mockToolActor: ActorDef<ToolMsg, null> = {
      initialState: null,
      handler: onMessage({
        invoke: (state, msg) => {
          msg.replyTo.send({
            type: 'toolPending',
            jobId: 'job-xyz',
            placeholderText: 'Please wait...'
          })
          return { state }
        }
      })
    }
    const mockRef = system.spawn('mock-tool-actor-pending', mockToolActor)
    await tick()

    const descriptor: SCRDescriptor = {
      urn: 'scr:leaf:test.long',
      kind: 'leaf',
      description: 'Long running tool',
      schema: {},
      target: mockRef
    }

    system.publish(SCRRegistrationTopic, {
      type: 'register',
      descriptor
    })
    await tick()

    const reply = await invokeSCR('scr:leaf:test.long', {})
    expect(reply.type).toBe('pending')
    if (reply.type === 'pending') {
      expect(reply.jobId).toBe('job-xyz')
      expect(reply.placeholderText).toBe('Please wait...')
    }

    await system.shutdown()
  })
})
