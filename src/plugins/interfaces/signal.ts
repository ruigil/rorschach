import { createConnection } from 'node:net'
import type { Socket } from 'node:net'
import type { ActorDef } from '../../system/types.ts'
import { onLifecycle, onMessage } from '../../system/match.ts'
import { emit } from '../../system/types.ts'
import { WsConnectTopic, WsMessageTopic, WsSendTopic, ImageGeneratedTopic } from '../../types/ws.ts'

// ─── Markdown → Signal formatting ───
//
// signal-cli `send` accepts plain `message` text + `textStyles` array of "start:length:STYLE".
// This function strips all markdown markers, produces clean plain text, and tracks
// the byte-offset ranges for BOLD, ITALIC, STRIKETHROUGH, and MONOSPACE.
//
export type SignalFormatted = { message: string; textStyles: string[] }

export const renderForSignal = (md: string): SignalFormatted => {
  const spans: Array<{ start: number; length: number; style: string }> = []
  let pos = 0           // cursor into the plain-text output being built
  const parts: string[] = []

  // Append plain text (no style)
  const push = (text: string) => { if (text) { parts.push(text); pos += text.length } }

  // Parse inline markdown within a single line, calling push/pushStyled as we go.
  // Returns the plain text for the whole segment (used for nested calls like headers).
  const inline = (src: string): void => {
    let i = 0
    let plain = ''
    const flushPlain = () => { push(plain); plain = '' }

    while (i < src.length) {
      // Images — drop entirely
      if (src[i] === '!' && src[i+1] === '[') {
        const be = src.indexOf(']', i + 2)
        if (be !== -1 && src[be+1] === '(') {
          const pe = src.indexOf(')', be + 2)
          if (pe !== -1) { i = pe + 1; continue }
        }
      }
      // Links: [text](url) → text (url)
      if (src[i] === '[') {
        const be = src.indexOf(']', i + 1)
        if (be !== -1 && src[be+1] === '(') {
          const pe = src.indexOf(')', be + 2)
          if (pe !== -1) {
            flushPlain()
            const linkText = src.slice(i + 1, be)
            const url      = src.slice(be + 2, pe)
            const full     = `${linkText} (${url})`
            push(full)
            i = pe + 1; continue
          }
        }
      }
      // `inline code`
      if (src[i] === '`' && src[i+1] !== '`') {
        const end = src.indexOf('`', i + 1)
        if (end !== -1) {
          flushPlain()
          const before = pos
          push(src.slice(i + 1, end))
          spans.push({ start: before, length: pos - before, style: 'MONOSPACE' })
          i = end + 1; continue
        }
      }
      // ~~strikethrough~~
      if (src[i] === '~' && src[i+1] === '~') {
        const end = src.indexOf('~~', i + 2)
        if (end !== -1) {
          flushPlain()
          const before = pos
          push(src.slice(i + 2, end))
          spans.push({ start: before, length: pos - before, style: 'STRIKETHROUGH' })
          i = end + 2; continue
        }
      }
      // **bold** (before single *)
      if (src[i] === '*' && src[i+1] === '*') {
        const end = src.indexOf('**', i + 2)
        if (end !== -1) {
          flushPlain()
          const before = pos; inline(src.slice(i + 2, end))
          spans.push({ start: before, length: pos - before, style: 'BOLD' })
          i = end + 2; continue
        }
      }
      // __bold__
      if (src[i] === '_' && src[i+1] === '_') {
        const end = src.indexOf('__', i + 2)
        if (end !== -1) {
          flushPlain()
          const before = pos; inline(src.slice(i + 2, end))
          spans.push({ start: before, length: pos - before, style: 'BOLD' })
          i = end + 2; continue
        }
      }
      // *italic*
      if (src[i] === '*') {
        const end = src.indexOf('*', i + 1)
        if (end !== -1 && src[end+1] !== '*') {
          flushPlain()
          const before = pos; inline(src.slice(i + 1, end))
          spans.push({ start: before, length: pos - before, style: 'ITALIC' })
          i = end + 1; continue
        }
      }
      // _italic_
      if (src[i] === '_') {
        const end = src.indexOf('_', i + 1)
        if (end !== -1 && src[end+1] !== '_') {
          flushPlain()
          const before = pos; inline(src.slice(i + 1, end))
          spans.push({ start: before, length: pos - before, style: 'ITALIC' })
          i = end + 1; continue
        }
      }

      plain += src[i]!
      i++
    }
    flushPlain()
  }

  // ─── Line-by-line block processing ───

  const lines = md.split('\n')
  let inFence  = false
  let fenceStart = 0
  let firstLine  = true

  const nl = () => { if (!firstLine) { parts.push('\n'); pos++ } firstLine = false }

  for (const raw of lines) {
    // Code fence open/close
    if (/^```/.test(raw)) {
      if (!inFence) {
        nl(); fenceStart = pos; inFence = true
        push(raw + '\n'); continue
      } else {
        push(raw)
        spans.push({ start: fenceStart, length: pos - fenceStart, style: 'MONOSPACE' })
        inFence = false; continue
      }
    }
    if (inFence) { push(raw + '\n'); continue }

    // Horizontal rules → blank line
    if (/^[-*_]{3,}\s*$/.test(raw)) { nl(); push(''); continue }

    // ATX headers → plain title text, BOLD span
    const hm = raw.match(/^#{1,6}\s+(.+)$/)
    if (hm) {
      nl()
      const before = pos
      inline(hm[1]!.trim())
      spans.push({ start: before, length: pos - before, style: 'BOLD' })
      continue
    }

    // Unordered list marker
    const lineBody = raw.replace(/^(\s*)[-*+]\s+/, '$1• ')

    nl()
    inline(lineBody)
  }

  // Collapse triple+ newlines and trim leading/trailing whitespace.
  // After trimming we must shift all span offsets by the amount trimmed from the front.
  let message = parts.join('').replace(/\n{3,}/g, '\n\n')
  const leading = message.length - message.trimStart().length
  message = message.trim()

  const textStyles = spans
    .map(s => ({ ...s, start: s.start - leading }))
    .filter(s => s.start >= 0 && s.length > 0 && s.start + s.length <= message.length)
    .map(s => `${s.start}:${s.length}:${s.style}`)

  return { message, textStyles }
}

// ─── Options ───

export type SignalActorOptions = {
  host?:           string  // default: '127.0.0.1'
  port?:           number  // default: 7583
  account?:        string
  reconnectMs?:    number  // default: 3000
  attachmentsDir?: string
}

// ─── Message protocol ───

type Attachment = { id: string; contentType: string }

type Envelope = {
  source?:       string
  sourceNumber?: string
  dataMessage?:  { message?: string; attachments?: Attachment[] }
  syncMessage?:  { sentMessage?: { destination?: string; destinationNumber?: string; message?: string; attachments?: Attachment[] } }
}

type SignalMsg =
  | { type: '_reconnect' }
  | { type: '_socketClosed' }
  | { type: '_line';          line: string }
  | { type: '_send';          clientId: string; text: string }
  | { type: '_imageGenerated'; filePath: string }
  | { type: '_sendOk' }
  | { type: '_sendErr';        error: string }
  | { type: '_refreshTyping' }

// ─── State ───

export type SignalState = {
  seenIds: Set<string>
  pending: Map<string, string>  // clientId → buffered chunks waiting for 'done'
}

// ─── Actor factory ───

export const createSignalActor = (
  options?: SignalActorOptions,
): ActorDef<SignalMsg, SignalState> => {
  const host           = options?.host           ?? '127.0.0.1'
  const port           = options?.port           ?? 7583
  const account        = options?.account        ?? null
  const reconnectMs    = options?.reconnectMs    ?? 3_000
  const attachmentsDir = options?.attachmentsDir ?? `${process.env.HOME}/.local/share/signal-cli/attachments`

  let msgId        = 0
  let activeSocket: Socket | null = null

  const writeToSocket = (line: string): Promise<void> =>
    new Promise((resolve, reject) => {
      if (!activeSocket || activeSocket.destroyed) { reject(new Error('not connected')); return }
      try {
        activeSocket.write(line, err => err ? reject(err) : resolve())
      } catch (err) {
        reject(err)
      }
    })

  const rpcLine = (method: string, params: Record<string, unknown>): string =>
    JSON.stringify({ jsonrpc: '2.0', id: ++msgId, method, params }) + '\n'

  const sendOverSocket = (recipient: string, { message, textStyles }: SignalFormatted): Promise<void> =>
    writeToSocket(rpcLine('send', {
      ...(account ? { account } : {}),
      recipient: [recipient],
      message,
      ...(textStyles.length > 0 ? { textStyles } : {}),
    }))

  // Fire-and-forget — typing indicators are best-effort
  const sendTyping = (recipient: string, stop = false) => {
    if (!activeSocket || activeSocket.destroyed) return
    activeSocket.write(rpcLine('sendTyping', { ...(account ? { account } : {}), recipient: [recipient], stop }))
  }

  const attachmentPaths = (attachments: Attachment[]): string[] =>
    attachments.map(a => `${attachmentsDir}/${a.id}`)

  return {
    lifecycle: onLifecycle({
      start: (state, ctx) => {
        ctx.subscribe(WsSendTopic, e => ({ type: '_send' as const, clientId: e.clientId, text: e.text }))
        ctx.subscribe(ImageGeneratedTopic, e => ({ type: '_imageGenerated' as const, filePath: e.filePath }))
        ctx.timers.startSingleTimer('reconnect', { type: '_reconnect' }, 0)
        ctx.log.info(`signal actor: connecting to ${host}:${port}`)
        return { state }
      },

      stopped: (state) => {
        activeSocket?.destroy()
        activeSocket = null
        return { state }
      },
    }),

    handler: onMessage<SignalMsg, SignalState>({
      _reconnect: (state, _msg, ctx) => {
        const self    = ctx.self
        const socket  = createConnection(port, host)
        let   lineBuf = ''

        socket.on('connect', () => {
          activeSocket = socket
          ctx.log.info(`signal: connected to ${host}:${port}`)
        })

        socket.on('data', (chunk: Buffer) => {
          lineBuf += chunk.toString()
          const lines = lineBuf.split('\n')
          lineBuf = lines.pop()!
          for (const line of lines) if (line.trim()) self.send({ type: '_line', line: line.trim() })
        })

        socket.on('close', () => {
          if (activeSocket === socket) {
            activeSocket = null
            self.send({ type: '_socketClosed' })
          }
        })

        socket.on('error', (err: Error) => {
          ctx.log.error(`signal: ${err.message}`)
          // 'close' fires after 'error' — _socketClosed will schedule the reconnect
        })

        return { state }
      },

      _socketClosed: (state, _msg, ctx) => {
        ctx.log.warn(`signal: disconnected, reconnecting in ${reconnectMs}ms`)
        ctx.timers.startSingleTimer('reconnect', { type: '_reconnect' }, reconnectMs)
        return { state }
      },

      _line: (state, msg, ctx) => {
        let parsed: any
        try { parsed = JSON.parse(msg.line) } catch {
          ctx.log.warn(`signal: malformed line: ${msg.line.slice(0, 80)}`)
          return { state }
        }

        const envelope: Envelope | undefined = parsed?.params?.envelope
        if (!envelope) return { state }

        const sent        = envelope.syncMessage?.sentMessage
        const source      = envelope.source ?? envelope.sourceNumber ?? sent?.destination ?? sent?.destinationNumber
        const text        = envelope.dataMessage?.message ?? sent?.message ?? ''
        const attachments = envelope.dataMessage?.attachments ?? sent?.attachments ?? []

        if (!source || (!text && attachments.length === 0)) return { state }

        const seenIds = new Set(state.seenIds)
        const events  = []

        if (!seenIds.has(source)) {
          seenIds.add(source)
          events.push(emit(WsConnectTopic, { clientId: source }))
        }

        events.push(emit(WsMessageTopic, {
          clientId:     source,
          text,
          ...(attachments.length > 0 ? { images: attachmentPaths(attachments) } : {}),
          traceId:      crypto.randomUUID(),
          parentSpanId: crypto.randomUUID(),
        }))

        return { state: { ...state, seenIds }, events }
      },

      _send: (state, msg, ctx) => {
        let ev: Record<string, unknown>
        try { ev = JSON.parse(msg.text) } catch { return { state } }

        switch (ev.type) {
          case 'chunk': {
            const isFirst = !state.pending.has(msg.clientId)
            if (isFirst) {
              sendTyping(msg.clientId)
              if (!ctx.timers.isActive('typing')) {
                ctx.timers.startPeriodicTimer('typing', { type: '_refreshTyping' }, 10_000)
              }
            }
            const pending = new Map(state.pending)
            pending.set(msg.clientId, (pending.get(msg.clientId) ?? '') + String(ev.text ?? ''))
            return { state: { ...state, pending } }
          }

          case 'done': {
            const raw = state.pending.get(msg.clientId)
            if (!raw) return { state }
            const pending = new Map(state.pending)
            pending.delete(msg.clientId)
            sendTyping(msg.clientId, true)
            if (pending.size === 0) ctx.timers.cancel('typing')
            ctx.pipeToSelf(
              sendOverSocket(msg.clientId, renderForSignal(raw)),
              ()    => ({ type: '_sendOk'  as const }),
              (err) => ({ type: '_sendErr' as const, error: String(err) }),
            )
            return { state: { ...state, pending } }
          }

          case 'error': {
            const text = String(ev.text ?? 'unknown error')
            sendTyping(msg.clientId, true)
            const pendingAfterErr = new Map(state.pending)
            pendingAfterErr.delete(msg.clientId)
            if (pendingAfterErr.size === 0) ctx.timers.cancel('typing')
            ctx.pipeToSelf(
              sendOverSocket(msg.clientId, { message: `⚠️ ${text}`, textStyles: [] }),
              ()    => ({ type: '_sendOk'  as const }),
              (err) => ({ type: '_sendErr' as const, error: String(err) }),
            )
            return { state }
          }

          default:
            return { state }
        }
      },

      _imageGenerated: (state, msg, ctx) => {
        for (const recipient of state.seenIds) {
          ctx.pipeToSelf(
            writeToSocket(rpcLine('send', {
              ...(account ? { account } : {}),
              recipient: [recipient],
              message: '',
              attachments: [msg.filePath],
            })),
            () => ({ type: '_sendOk'  as const }),
            (err) => ({ type: '_sendErr' as const, error: String(err) }),
          )
        }
        return { state }
      },

      _sendOk: (state) => ({ state }),

      _sendErr: (state, msg, ctx) => {
        ctx.log.error(`signal: send failed: ${msg.error}`)
        return { state }
      },

      _refreshTyping: (state) => {
        for (const clientId of state.pending.keys()) sendTyping(clientId)
        return { state }
      },
    }),
  }
}
