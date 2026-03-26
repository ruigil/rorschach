import { describe, test, expect, afterEach, beforeAll } from 'bun:test'
import { createPluginSystem } from '../system/index.ts'
import { createSignalActor, renderForSignal } from '../plugins/interfaces/signal.ts'
import { WsConnectTopic, WsMessageTopic, WsSendTopic } from '../system/topics.ts'
import type { WsConnectEvent, WsMessageEvent } from '../system/topics.ts'

const tick = (ms = 50) => Bun.sleep(ms)

// ─── Minimal signal-cli JSON-RPC stub ───

type RpcHandler = (method: string, params: Record<string, unknown>) => unknown

function startMockSignalServer(port: number, handle: RpcHandler) {
  return Bun.serve({
    port,
    async fetch(req) {
      const body = await req.json() as { method: string; params: Record<string, unknown>; id: number }
      const result = handle(body.method, body.params ?? {})
      return Response.json({ jsonrpc: '2.0', id: body.id, result })
    },
  })
}

// ═══════════════════════════════════════════════════════════════════
// Signal actor: HTTP polling
// ═══════════════════════════════════════════════════════════════════

describe('signal actor: HTTP polling', () => {
  let server: ReturnType<typeof Bun.serve> | null = null

  afterEach(async () => {
    await server?.stop()
    server = null
  })

  test('polls receive and emits WsConnect + WsMessage for a new sender', async () => {
    const connectEvents: WsConnectEvent[] = []
    const messageEvents: WsMessageEvent[] = []

    let callCount = 0
    server = startMockSignalServer(17583, (method) => {
      if (method !== 'receive') return []
      callCount++
      if (callCount === 1) {
        return [{
          envelope: {
            source:       '+1111111111',
            dataMessage:  { message: 'hello from signal' },
          },
        }]
      }
      return []
    })

    const system = await createPluginSystem()
    system.subscribe(WsConnectTopic,  e => connectEvents.push(e))
    system.subscribe(WsMessageTopic,  e => messageEvents.push(e))

    system.spawn('signal', createSignalActor({
      url:            'http://127.0.0.1:17583',
      pollIntervalMs: 80,
    }), { seenIds: new Set<string>(), pending: new Map<string, string>() })

    await tick(200)

    expect(connectEvents).toHaveLength(1)
    expect(connectEvents.at(0)!.clientId).toBe('+1111111111')

    expect(messageEvents.length).toBeGreaterThanOrEqual(1)
    expect(messageEvents.at(0)!.clientId).toBe('+1111111111')
    expect(messageEvents.at(0)!.text).toBe('hello from signal')

    await system.shutdown()
  })

  test('does not re-emit WsConnect for the same sender on subsequent polls', async () => {
    const connectEvents: WsConnectEvent[] = []

    server = startMockSignalServer(17584, (method) => {
      if (method !== 'receive') return []
      return [{
        envelope: {
          source:      '+2222222222',
          dataMessage: { message: 'hi' },
        },
      }]
    })

    const system = await createPluginSystem()
    system.subscribe(WsConnectTopic, e => connectEvents.push(e))

    system.spawn('signal', createSignalActor({
      url:            'http://127.0.0.1:17584',
      pollIntervalMs: 60,
    }), { seenIds: new Set<string>(), pending: new Map<string, string>() })

    await tick(300)

    // Multiple polls, but WsConnect should fire only once per unique sender
    expect(connectEvents.filter(e => e.clientId === '+2222222222')).toHaveLength(1)

    await system.shutdown()
  })

  test('sends a message via HTTP POST when WsSend topic fires', async () => {
    const sentRequests: Array<{ method: string; params: Record<string, unknown> }> = []

    server = startMockSignalServer(17585, (method, params) => {
      sentRequests.push({ method, params })
      return method === 'send' ? { timestamp: Date.now() } : []
    })

    const system = await createPluginSystem()

    system.spawn('signal', createSignalActor({
      url:            'http://127.0.0.1:17585',
      account:        '+0000000000',
      pollIntervalMs: 5_000,   // long interval — we don't care about polling here
    }), { seenIds: new Set<string>(), pending: new Map<string, string>() })

    await tick(50)

    // simulate chatbot streaming markdown: chunks accumulate, 'done' flushes rendered text
    const md = '## Result\n\n**Important**: hello _world_'
    system.publish(WsSendTopic, { clientId: '+3333333333', text: JSON.stringify({ type: 'chunk', text: md }) })
    system.publish(WsSendTopic, { clientId: '+3333333333', text: JSON.stringify({ type: 'done' }) })
    await tick(200)

    const sendCall = sentRequests.find(r => r.method === 'send')
    expect(sendCall).toBeDefined()
    expect(sendCall!.params.account).toBe('+0000000000')
    expect(sendCall!.params.recipient).toEqual(['+3333333333'])
    // plain text — no markdown markers
    expect(sendCall!.params.message).toBe('Result\n\nImportant: hello world')
    // formatting encoded as textStyles ranges
    expect(sendCall!.params.textStyles).toContain('0:6:BOLD')       // "Result"
    expect(sendCall!.params.textStyles).toContain('8:9:BOLD')       // "Important"
    expect(sendCall!.params.textStyles).toContain('25:5:ITALIC')    // "world"

    await system.shutdown()
  })

  test('integration: sends a real message to +41762189620 via signal-cli', async () => {
    let sendResult: unknown = null
    let sendError:  string | null = null

    const system = await createPluginSystem()

    system.spawn('signal', createSignalActor({
      url:            'http://127.0.0.1:7583/api/v1/rpc',
      account:        '+41762189620',
      pollIntervalMs: 5_000,
    }), { seenIds: new Set<string>(), pending: new Map<string, string>() })

    // subscribe to _sendErr surfaced as a log — instead just watch for errors
    // by piping the raw fetch ourselves to capture the result
    const fetchResult = await fetch('http://127.0.0.1:7583/api/v1/rpc', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 99, method: 'send',
        params: {
          account:   '+41762189620',
          recipient: ['+41762189620'],
          message:   'test from rorschach signal actor',
        },
      }),
    }).then(r => r.json()).catch(e => { sendError = String(e); return null })

    sendResult = fetchResult

    expect(sendError).toBeNull()
    expect((sendResult as any)?.error).toBeUndefined()
    expect((sendResult as any)?.result).toBeDefined()

    await system.shutdown()
  })

  test('integration: receives a pending message from signal-cli', async () => {
    const res: any = await fetch('http://127.0.0.1:7583/api/v1/rpc', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 100, method: 'receive',
        params: {},
      }),
    }).then(r => r.json())

    console.log('receive result:', JSON.stringify(res, null, 2))

    // signal-cli only allows one concurrent receive call — if the daemon
    // is already receiving (e.g. from a polling actor), that's an expected response
    const alreadyReceiving = res.error?.message?.includes('already being received')
    if (!alreadyReceiving) {
      expect(res.error).toBeUndefined()
      expect(Array.isArray(res.result)).toBe(true)
    }
  })

  test('logs an error and keeps running when the HTTP call fails', async () => {
    // Point at a port with no server — fetch will reject
    const system = await createPluginSystem()

    // verify the actor does not crash — the system stays running
    const ref = system.spawn('signal', createSignalActor({
      url:            'http://127.0.0.1:19999',
      pollIntervalMs: 60,
    }), { seenIds: new Set<string>(), pending: new Map<string, string>() })

    await tick(250)

    expect(ref.isAlive()).toBe(true)

    await system.shutdown()
  })
})

// ═══════════════════════════════════════════════════════════════════
// renderForSignal: markdown → Signal formatting
// ═══════════════════════════════════════════════════════════════════

describe('renderForSignal', () => {
  const msg  = (md: string) => renderForSignal(md).message
  const stys = (md: string) => renderForSignal(md).textStyles

  test('ATX headers → plain text + BOLD span', () => {
    expect(msg('## Hello')).toBe('Hello')
    expect(stys('## Hello')).toContain('0:5:BOLD')

    expect(msg('# H1\n### H3')).toBe('H1\nH3')
    expect(stys('# H1\n### H3')).toContain('0:2:BOLD')
    expect(stys('# H1\n### H3')).toContain('3:2:BOLD')
  })

  test('**bold** and __bold__ → plain text + BOLD span', () => {
    expect(msg('**important**')).toBe('important')
    expect(stys('**important**')).toContain('0:9:BOLD')

    expect(msg('__important__')).toBe('important')
    expect(stys('__important__')).toContain('0:9:BOLD')
  })

  test('*italic* and _italic_ → plain text + ITALIC span', () => {
    expect(msg('_hello_')).toBe('hello')
    expect(stys('_hello_')).toContain('0:5:ITALIC')

    expect(msg('*hello*')).toBe('hello')
    expect(stys('*hello*')).toContain('0:5:ITALIC')
  })

  test('~~strike~~ → plain text + STRIKETHROUGH span', () => {
    expect(msg('~~old~~')).toBe('old')
    expect(stys('~~old~~')).toContain('0:3:STRIKETHROUGH')
  })

  test('`code` → plain text + MONOSPACE span', () => {
    expect(msg('run `ls -la` here')).toBe('run ls -la here')
    expect(stys('run `ls -la` here')).toContain('4:6:MONOSPACE')
  })

  test('unordered list markers → •', () => {
    expect(msg('- item one\n- item two')).toBe('• item one\n• item two')
    expect(msg('* item')).toBe('• item')
  })

  test('[text](url) links → text (url)', () => {
    expect(msg('[click here](https://example.com)')).toBe('click here (https://example.com)')
  })

  test('horizontal rules → blank line', () => {
    expect(msg('before\n---\nafter')).toBe('before\n\nafter')
  })

  test('code fences → MONOSPACE span over content', () => {
    const src = '```ts\nconst x = 1\n```'
    const { message, textStyles } = renderForSignal(src)
    expect(message).toBe(src)
    expect(textStyles.some(s => s.endsWith(':MONOSPACE'))).toBe(true)
  })

  test('collapses excess blank lines', () => {
    expect(msg('a\n\n\n\nb')).toBe('a\n\nb')
  })

  test('realistic LLM response', () => {
    const input = '## Summary\n\n**Key point**: use _this_ approach.\n\n- step one\n- step two\n\n[docs](https://example.com)'
    const { message, textStyles } = renderForSignal(input)
    expect(message).toBe('Summary\n\nKey point: use this approach.\n\n• step one\n• step two\n\ndocs (https://example.com)')
    expect(textStyles).toContain('0:7:BOLD')       // Summary
    expect(textStyles).toContain('9:9:BOLD')       // Key point
    expect(textStyles).toContain('24:4:ITALIC')    // this
  })
})
