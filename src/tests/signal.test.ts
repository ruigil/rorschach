import { describe, test, expect, afterEach } from 'bun:test'
import { tmpdir } from 'node:os'
import { mkdirSync } from 'node:fs'
import { createPluginSystem } from '../system/index.ts'
import { createSignalActor, renderForSignal } from '../plugins/interfaces/signal.ts'
import { ClientConnectTopic, InboundMessageTopic, OutboundMessageTopic } from '../types/events.ts'
import type { ClientConnectEvent, InboundMessageEvent } from '../types/events.ts'

const tick = (ms = 50) => Bun.sleep(ms)

// ─── Mock signal-cli TCP daemon ───
//
// Accepts TCP connections, pushes newline-delimited JSON-RPC notifications,
// and captures any JSON-RPC requests sent back by the actor.
//
function startMockSignalDaemon(port: number) {
  type BunSocket = Parameters<NonNullable<Parameters<typeof Bun.listen>[0]['socket']['open']>>[0]
  const sockets: BunSocket[] = []
  const receivedLines: string[] = []
  let buf = ''

  const server = Bun.listen({
    hostname: '127.0.0.1',
    port,
    socket: {
      open(s)       { sockets.push(s) },
      data(_s, raw) {
        buf += raw.toString()
        const lines = buf.split('\n')
        buf = lines.pop()!
        for (const l of lines) if (l.trim()) receivedLines.push(l.trim())
      },
      close(s)  { const i = sockets.indexOf(s); if (i >= 0) sockets.splice(i, 1) },
      error()   {},
    },
  })

  const pushEnvelope = (envelope: object) => {
    const line = JSON.stringify({ jsonrpc: '2.0', method: 'receive', params: { envelope } }) + '\n'
    for (const s of sockets) s.write(line)
  }

  const closeClients = () => { for (const s of [...sockets]) s.end() }
  const stop         = () => server.stop(true)

  return { pushEnvelope, receivedLines, closeClients, stop, get clientCount() { return sockets.length } }
}

// ═══════════════════════════════════════════════════════════════════
// Signal actor: TCP socket
// ═══════════════════════════════════════════════════════════════════

describe('signal actor: TCP socket', () => {
  let daemon: ReturnType<typeof startMockSignalDaemon> | null = null

  afterEach(async () => {
    daemon?.stop()
    daemon = null
  })

  test('emits WsConnect + WsMessage when the daemon pushes an envelope', async () => {
    const connectEvents: ClientConnectEvent[] = []
    const messageEvents: InboundMessageEvent[] = []

    daemon = startMockSignalDaemon(17590)
    const system = await createPluginSystem()
    system.subscribe(ClientConnectTopic,  e => connectEvents.push(e))
    system.subscribe(InboundMessageTopic,  e => messageEvents.push(e))

    system.spawn('signal', createSignalActor({ host: '127.0.0.1', port: 17590 }),
      { seenIds: new Set<string>(), pending: new Map<string, string>(), activeSpans: {}, identityProviderRef: null, pendingConnect: new Map() })

    await tick(100)
    daemon.pushEnvelope({ source: '+1111111111', dataMessage: { message: 'hello via tcp' } })
    await tick(100)

    expect(connectEvents).toHaveLength(1)
    expect(connectEvents[0]!.clientId).toBe('+1111111111')
    expect(messageEvents).toHaveLength(1)
    expect(messageEvents[0]!.text).toBe('hello via tcp')

    await system.shutdown()
  })

  test('does not re-emit WsConnect for the same sender on a second message', async () => {
    const connectEvents: ClientConnectEvent[] = []

    daemon = startMockSignalDaemon(17591)
    const system = await createPluginSystem()
    system.subscribe(ClientConnectTopic, e => connectEvents.push(e))

    system.spawn('signal', createSignalActor({ host: '127.0.0.1', port: 17591 }),
      { seenIds: new Set<string>(), pending: new Map<string, string>(), activeSpans: {}, identityProviderRef: null, pendingConnect: new Map() })

    await tick(100)
    daemon.pushEnvelope({ source: '+2222222222', dataMessage: { message: 'first' } })
    daemon.pushEnvelope({ source: '+2222222222', dataMessage: { message: 'second' } })
    await tick(100)

    expect(connectEvents.filter(e => e.clientId === '+2222222222')).toHaveLength(1)

    await system.shutdown()
  })

  test('sends a JSON-RPC request over TCP when WsSend fires', async () => {
    daemon = startMockSignalDaemon(17592)

    const system = await createPluginSystem()
    system.spawn('signal', createSignalActor({ host: '127.0.0.1', port: 17592, account: '+0000000000' }),
      { seenIds: new Set<string>(), pending: new Map<string, string>(), activeSpans: {}, identityProviderRef: null, pendingConnect: new Map() })

    await tick(100)

    const md = '**hello** _world_'
    system.publish(OutboundMessageTopic, { clientId: '+3333333333', text: JSON.stringify({ type: 'chunk', text: md }) })
    system.publish(OutboundMessageTopic, { clientId: '+3333333333', text: JSON.stringify({ type: 'done' }) })
    await tick(200)

    const sendLine = daemon.receivedLines.find(l => {
      try { return JSON.parse(l).method === 'send' } catch { return false }
    })
    expect(sendLine).toBeDefined()
    const req = JSON.parse(sendLine!)
    expect(req.params.account).toBe('+0000000000')
    expect(req.params.recipient).toEqual(['+3333333333'])
    expect(req.params.message).toBe('hello world')
    expect(req.params.textStyles).toContain('0:5:BOLD')
    expect(req.params.textStyles).toContain('6:5:ITALIC')

    await system.shutdown()
  })

  test('emits WsMessage with images when an envelope contains attachments', async () => {
    const messageEvents: InboundMessageEvent[] = []

    const attachmentsDir = `${tmpdir()}/rorschach-test-${crypto.randomUUID()}`
    const attachmentId   = 'test-attach-001'
    mkdirSync(attachmentsDir, { recursive: true })
    Bun.write(`${attachmentsDir}/${attachmentId}`, 'dummy image data')

    daemon = startMockSignalDaemon(17595)
    const system = await createPluginSystem()
    system.subscribe(InboundMessageTopic, e => messageEvents.push(e))

    system.spawn('signal', createSignalActor({ host: '127.0.0.1', port: 17595, attachmentsDir }),
      { seenIds: new Set<string>(), pending: new Map<string, string>(), activeSpans: {}, identityProviderRef: null, pendingConnect: new Map() })

    await tick(100)
    daemon.pushEnvelope({
      source:      '+5555555555',
      dataMessage: {
        message:     'check this out',
        attachments: [{ id: attachmentId, contentType: 'image/jpeg' }],
      },
    })
    await tick(200)

    expect(messageEvents).toHaveLength(1)
    expect(messageEvents[0]!.clientId).toBe('+5555555555')
    expect(messageEvents[0]!.text).toBe('check this out')
    expect(messageEvents[0]!.images).toHaveLength(1)
    const inboundPath = messageEvents[0]!.images![0]!
    expect(inboundPath).toInclude('workspace/media/inbound/rorschach-')
    expect(inboundPath).toEndWith('.jpg')
    expect(await Bun.file(inboundPath).exists()).toBe(true)

    await system.shutdown()
  })

  test('reconnects after the daemon drops the connection', async () => {
    const messageEvents: InboundMessageEvent[] = []

    daemon = startMockSignalDaemon(17593)
    const system = await createPluginSystem()
    system.subscribe(InboundMessageTopic, e => messageEvents.push(e))

    system.spawn('signal', createSignalActor({ host: '127.0.0.1', port: 17593, reconnectMs: 200 }),
      { seenIds: new Set<string>(), pending: new Map<string, string>(), activeSpans: {}, identityProviderRef: null, pendingConnect: new Map() })

    await tick(100)
    daemon.closeClients()
    await tick(400)

    daemon.pushEnvelope({ source: '+4444444444', dataMessage: { message: 'after reconnect' } })
    await tick(100)

    expect(messageEvents.some(e => e.text === 'after reconnect')).toBe(true)

    await system.shutdown()
  })

  test('survives malformed JSON lines without crashing', async () => {
    type BunSocket = Parameters<NonNullable<Parameters<typeof Bun.listen>[0]['socket']['open']>>[0]
    let clientSocket: BunSocket | null = null
    const server = Bun.listen({
      hostname: '127.0.0.1', port: 17594,
      socket: {
        open(s)  { clientSocket = s },
        data()   {},
        close()  {},
        error()  {},
      },
    })

    const system = await createPluginSystem()
    const ref = system.spawn('signal', createSignalActor({ host: '127.0.0.1', port: 17594 }),
      { seenIds: new Set<string>(), pending: new Map<string, string>(), activeSpans: {}, identityProviderRef: null, pendingConnect: new Map() })

    await tick(100)
    clientSocket!.write('this is not json\n')
    clientSocket!.write('{broken\n')
    await tick(100)

    expect(ref.isAlive()).toBe(true)

    server.stop(true)
    await system.shutdown()
  })

  test('stays alive when no daemon is listening', async () => {
    const system = await createPluginSystem()
    const ref = system.spawn('signal', createSignalActor({ host: '127.0.0.1', port: 19998, reconnectMs: 100 }),
      { seenIds: new Set<string>(), pending: new Map<string, string>(), activeSpans: {}, identityProviderRef: null, pendingConnect: new Map() })

    await tick(400)

    expect(ref.isAlive()).toBe(true)

    await system.shutdown()
  })

  test('integration: receives messages and attachments from signal-cli TCP at 127.0.0.1:7583', async () => {
    const connectEvents: ClientConnectEvent[] = []
    const messageEvents: InboundMessageEvent[] = []

    const system = await createPluginSystem()
    system.subscribe(ClientConnectTopic, e => connectEvents.push(e))
    system.subscribe(InboundMessageTopic, e => messageEvents.push(e))

    const ref = system.spawn('signal', createSignalActor({
      host: '127.0.0.1',
      port: 7583,
    }), { seenIds: new Set<string>(), pending: new Map<string, string>(), activeSpans: {}, identityProviderRef: null, pendingConnect: new Map() })

    await tick(2_000)  // wait for any queued messages to be pushed by the daemon

    expect(ref.isAlive()).toBe(true)
    console.log(`received ${messageEvents.length} message(s) from ${connectEvents.length} sender(s)`)
    for (const e of messageEvents) {
      console.log(`  [${e.clientId}] ${e.text}`)
      if (e.images) {
        console.log(`    attachments (${e.images.length}):`)
        for (const path of e.images) {
          const file = Bun.file(path)
          console.log(`      ${path} (${await file.exists() ? file.size + ' bytes' : 'missing'})`)
        }
      }
    }

    await system.shutdown()
  })

  test('integration: sends a real message via signal-cli TCP at 127.0.0.1:7583', async () => {
    const system = await createPluginSystem()

    const ref = system.spawn('signal', createSignalActor({
      host:    '127.0.0.1',
      port:    7583,
      account: '+41762189620',
    }), { seenIds: new Set<string>(), pending: new Map<string, string>(), activeSpans: {}, identityProviderRef: null, pendingConnect: new Map() })

    await tick(200)  // wait for connection

    system.publish(OutboundMessageTopic, { clientId: '+41762189620', text: JSON.stringify({ type: 'chunk', text: 'test from rorschach TCP actor' }) })
    system.publish(OutboundMessageTopic, { clientId: '+41762189620', text: JSON.stringify({ type: 'done' }) })

    await tick(500)

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
