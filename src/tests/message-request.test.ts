import { describe, test, expect } from 'bun:test'
import {
  AgentSystem,
  createMessageRequest,
  encodeMessageRequest,
  decodeMessageRequest,
  onMessage,
  type MessageRequest,
  type ActorRef,
} from '../system/index.ts'

describe('Unified MessageRequest & Context Propagation', () => {
  test('encodeMessageRequest & decodeMessageRequest roundtrip proxy-friendly headers', () => {
    const original: MessageRequest = {
      traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
      spanId: '00f067aa0ba902b7',
      userId: 'usr_alice',
      roles: ['user', 'developer'],
      permission: { grants: ['coding_shell_exec', 'memory_recall'] },
      clientId: 'cli_client_123',
      timezone: 'Europe/Paris',
      source: 'http',
    }

    const headers = encodeMessageRequest(original)
    expect(headers['traceparent']).toBe('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01')
    expect(headers['x-user-id']).toBe('usr_alice')
    expect(headers['x-user-roles']).toBe('user,developer')
    expect(headers['x-client-id']).toBe('cli_client_123')
    expect(headers['x-timezone']).toBe('Europe/Paris')
    expect(headers['x-client-source']).toBe('http')

    const decoded = decodeMessageRequest(headers)
    expect(decoded.traceId).toBe(original.traceId)
    expect(decoded.userId).toBe(original.userId)
    expect(decoded.roles).toEqual(original.roles)
    expect(decoded.permission).toEqual(original.permission)
    expect(decoded.clientId).toBe(original.clientId)
    expect(decoded.timezone).toBe(original.timezone)
    expect(decoded.source).toBe(original.source)
  })

  test('ActorContext exposes ctx.request to actor handlers', async () => {
    const system = await AgentSystem()
    let capturedRequest: MessageRequest | undefined

    type TargetMsg = { type: 'ping' }
    const targetDef = {
      initialState: () => ({}),
      handler: onMessage<TargetMsg, {}>({
        ping: (state: {}, _msg: TargetMsg, ctx: any) => {
          capturedRequest = ctx.request
          return { state }
        },
      }),
    }

    const ref = system.spawn('target', targetDef)
    const req = createMessageRequest({
      userId: 'usr_bob',
      roles: ['developer'],
      permission: { grants: ['*'] },
      source: 'websocket',
    })

    ref.send({ type: 'ping' }, req)
    await new Promise(r => setTimeout(r, 20))

    expect(capturedRequest).toBeDefined()
    expect(capturedRequest?.userId).toBe('usr_bob')
    expect(capturedRequest?.roles).toEqual(['developer'])
    expect(capturedRequest?.permission?.grants).toEqual(['*'])
    expect(capturedRequest?.source).toBe('websocket')

    system.shutdown()
  })

  test('ctx.send automatically propagates and chains request context between actors', async () => {
    const system = await AgentSystem()
    let downstreamRequest: MessageRequest | undefined

    type BMsg = { type: 'helloB' }
    const actorBDef = {
      initialState: () => ({}),
      handler: onMessage<BMsg, {}>({
        helloB: (state: {}, _msg: BMsg, ctx: any) => {
          downstreamRequest = ctx.request
          return { state }
        },
      }),
    }

    type AMsg = { type: 'forward'; target: ActorRef<BMsg> }
    const actorADef = {
      initialState: () => ({}),
      handler: onMessage<AMsg, {}>({
        forward: (state: {}, msg: AMsg, ctx: any) => {
          ctx.send(msg.target, { type: 'helloB' })
          return { state }
        },
      }),
    }

    const refA = system.spawn('actorA', actorADef)
    const refB = system.spawn('actorB', actorBDef)

    const initialReq = createMessageRequest({
      traceId: 'trace_12345',
      spanId: 'span_parent',
      userId: 'usr_charlie',
      source: 'cli',
    })

    refA.send({ type: 'forward', target: refB }, initialReq)
    await new Promise(r => setTimeout(r, 20))

    expect(downstreamRequest).toBeDefined()
    expect(downstreamRequest?.traceId).toBe('trace_12345')
    expect(downstreamRequest?.parentSpanId).toBe('span_parent')
    expect(downstreamRequest?.userId).toBe('usr_charlie')
    expect(downstreamRequest?.source).toBe('cli')

    system.shutdown()
  })

  test('ctx.trace.span automatically creates child span under ctx.request.traceId', async () => {
    const system = await AgentSystem()
    let spanTraceId: string | undefined

    type WorkerMsg = { type: 'work' }
    const workerDef = {
      initialState: () => ({}),
      handler: onMessage<WorkerMsg, {}>({
        work: (state: {}, _msg: WorkerMsg, ctx: any) => {
          const span = ctx.trace.span('tool_exec', { tool: 'shell' })
          spanTraceId = span.traceId
          span.done({ success: true })
          return { state }
        },
      }),
    }

    const workerRef = system.spawn('worker', workerDef)
    const req = createMessageRequest({
      traceId: 'trace_span_test_99',
      spanId: 'span_parent_88',
      userId: 'usr_dave',
    })

    workerRef.send({ type: 'work' }, req)
    await new Promise(r => setTimeout(r, 20))

    expect(spanTraceId).toBe('trace_span_test_99')

    system.shutdown()
  })
})
