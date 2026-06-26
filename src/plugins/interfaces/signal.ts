import { createConnection } from 'node:net'
import type { Socket } from 'node:net'
import { copyFile, mkdir } from 'node:fs/promises'
import type { ActorDef, ActorRef, SpanHandle } from '../../system/index.ts'
import { emit } from '../../system/index.ts'
import { onLifecycle, onMessage } from '../../system/index.ts'
import { join } from 'node:path'
import { ask } from '../../system/index.ts'

import { UserPresenceTopic, InboundMessageTopic, OutboundUserMessageTopic, type MessageAttachment } from '../../types/events.ts'
import { IdentityProviderTopic } from '../../types/identity.ts'
import { resolveIdentity } from './types.ts'
import type { IdentityProviderMsg, Identity } from '../../types/identity.ts'
import type { ToolSource } from '../../types/tools.ts'

const INBOUND_DIR = join(import.meta.dir, '../../..', 'workspace/media/inbound')
const MEDIA_DIR   = join(import.meta.dir, '../../..', 'workspace/media')

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

export type SignalOptions = {
  host?:           string     // default: '127.0.0.1'
  port?:           number     // default: 7583
  account?:        string
  reconnectMs?:    number     // default: 3000
  presenceTtlMs?:  number     // default: 60 minutes
  attachmentsDir?: string
}

// ─── Message protocol ───

type Attachment = { id: string; contentType: string }

type Envelope = {
  source?:       string
  sourceNumber?: string
  dataMessage?:  { message?: string; attachments?: Attachment[]; groupInfo?: { groupId?: string } }
  syncMessage?:  { sentMessage?: { destination?: string; destinationNumber?: string; message?: string; attachments?: Attachment[]; groupInfo?: { groupId?: string } } }
}

type BufferedMsg = { text: string; attachments?: MessageAttachment[] }

type PendingTurn = { text: string; attachments: MessageAttachment[]; sources: ToolSource[] }

type SignalMsg =
  | { type: '_reconnect' }
  | { type: '_socketClosed' }
  | { type: '_line';                  line: string }
  | { type: '_send';                  userId: string; text: string }
  | { type: '_sendOk' }
  | { type: '_sendErr';               error: string }
  | { type: '_refreshTyping' }
  | { type: '_identityProviderChanged'; ref: ActorRef<IdentityProviderMsg> | null }
  | { type: '_phoneResolved';         phone: string; userId: string }
  | { type: '_phoneRejected';         phone: string }
  | { type: '_presenceExpired';       phone: string }
  | { type: '_attachmentsCopied';     phone: string; text: string; messageAttachments: MessageAttachment[] }

// ─── State ───

export type SignalState = {
  seenIds:             Set<string>
  pending:             Map<string, PendingTurn>                  // clientId → buffered chunks/attachments waiting for 'done'
  activeSpans:         Record<string, SpanHandle>
  identityProviderRef: ActorRef<IdentityProviderMsg> | null
  pendingConnect:      Map<string, BufferedMsg[]>                // phone → buffered messages while resolving userId
  userIdToPhones:      Map<string, string[]>                     // userId → phone numbers
}

// ─── Actor factory ───

export const Signal = (
  options?: SignalOptions,
): ActorDef<SignalMsg, SignalState> => {
  const host           = options?.host           ?? '127.0.0.1'
  const port           = options?.port           ?? 7583
  const account        = options?.account        ?? null
  const reconnectMs    = options?.reconnectMs    ?? 3_000
  const presenceTtlMs  = options?.presenceTtlMs  ?? 60 * 60 * 1000
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

  const sendOverSocket = (clientId: string, { message, textStyles }: SignalFormatted, attachments: string[] = []): Promise<void> =>
    writeToSocket(rpcLine('send', {
      ...(account ? { account } : {}),
      recipient: [clientId],
      ...(message ? { message } : {}),
      ...(textStyles.length > 0 ? { textStyles } : {}),
      ...(attachments.length > 0 ? { attachments } : {}),
    }))

  // Fire-and-forget — typing indicators are best-effort
  const sendTyping = (recipient: string, stop = false) => {
    if (!activeSocket || activeSocket.destroyed) return
    activeSocket.write(rpcLine('sendTyping', { ...(account ? { account } : {}), recipient: [recipient], stop }))
  }

  const mimeToExt = (contentType: string): string => {
    const sub = contentType.split('/')[1] ?? 'bin'
    const aliases: Record<string, string> = { jpeg: 'jpg', 'x-m4a': 'm4a', mpeg: 'mp3' }
    return aliases[sub] ?? sub
  }

  const refreshPresenceExpiry = (phone: string, ctx: { timers: { startSingleTimer: (key: string, message: SignalMsg, delayMs: number) => void } }) => {
    ctx.timers.startSingleTimer(`presence:${phone}`, { type: '_presenceExpired', phone }, presenceTtlMs)
  }

  const processIncomingMessage = (state: SignalState, phone: string, text: string, messageAttachments: MessageAttachment[], ctx: any) => {
    // Already an identified, seen sender — emit directly
    if (state.seenIds.has(phone)) {
      refreshPresenceExpiry(phone, ctx)
      const span = ctx.trace.start('request', { clientId: phone })
      const activeSpans = { ...state.activeSpans, [phone]: span }

      let userId = ''
      for (const [uid, phones] of state.userIdToPhones.entries()) {
        if (phones.includes(phone)) {
          userId = uid
          break
        }
      }

      return {
        state: { ...state, activeSpans },
        events: [emit(InboundMessageTopic, {
          userId,
          text,
          attachments: messageAttachments.length > 0 ? messageAttachments : undefined,
          traceId:      span.traceId,
          parentSpanId: span.spanId,
        })],
      }
    }

    // New sender — buffer and resolve via userStore
    const existing = state.pendingConnect.get(phone) ?? []
    const pendingConnect = new Map(state.pendingConnect)
    pendingConnect.set(phone, [...existing, {
      text,
      attachments: messageAttachments.length > 0 ? messageAttachments : undefined,
    }])

    if (existing.length === 0) {
      ctx.pipeToSelf(
        resolveIdentity(state.identityProviderRef,
          r => ({ type: 'resolvePhone' as const, phone, replyTo: r })),
        (id: Identity | null): SignalMsg => id
          ? { type: '_phoneResolved', phone, userId: id.userId }
          : { type: '_phoneRejected', phone },
        (): SignalMsg => ({ type: '_phoneRejected', phone }),
      )
    }

    return { state: { ...state, pendingConnect } }
  }

  return {
    initialState: () => ({ seenIds: new Set<string>(), pending: new Map(), activeSpans: {}, identityProviderRef: null, pendingConnect: new Map(), userIdToPhones: new Map() }),
    lifecycle: onLifecycle({
      start: (state, ctx) => {
        ctx.subscribe(OutboundUserMessageTopic,    e => ({ type: '_send'             as const, userId: e.userId, text: e.text }))
        ctx.subscribe(IdentityProviderTopic, e => ({ type: '_identityProviderChanged' as const, ref: e.ref }))
        ctx.timers.startSingleTimer('reconnect', { type: '_reconnect' }, 0)
        ctx.log.info(`signal actor: connecting to ${host}:${port}`)
        return { state }
      },

      stopped: (state, ctx) => {
        for (const userId of state.userIdToPhones.keys()) {
          ctx.deleteRetained(UserPresenceTopic, userId, {
            status: 'absent',
            userId,
            source: 'signal',
          })
        }
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
        let   connecting = true

        socket.on('connect', () => {
          activeSocket = socket
          connecting = false
          ctx.log.info(`signal: connected to ${host}:${port}`)
        })

        socket.on('data', (chunk: Buffer) => {
          lineBuf += chunk.toString()
          const lines = lineBuf.split('\n')
          lineBuf = lines.pop()!
          for (const line of lines) if (line.trim()) self.send({ type: '_line', line: line.trim() })
        })

        socket.on('close', () => {
          if (activeSocket === socket || connecting) {
            if (activeSocket === socket) {
              activeSocket = null
            }
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

        const exception = parsed?.params?.exception
        if (exception) {
          ctx.log.error(`signal: daemon exception: ${exception.message} (${exception.type})`)
        }

        const envelope: Envelope | undefined = parsed?.params?.envelope
        if (!envelope) return { state }

        const sent           = envelope.syncMessage?.sentMessage
        const source         = envelope.source ?? envelope.sourceNumber ?? sent?.destination ?? sent?.destinationNumber
        const incomingGroup  = envelope.dataMessage?.groupInfo?.groupId ?? envelope.syncMessage?.sentMessage?.groupInfo?.groupId ?? null
        const text            = envelope.dataMessage?.message ?? sent?.message ?? ''
        const attachments      = envelope.dataMessage?.attachments ?? sent?.attachments ?? []

        if (!source) return { state }

        // Ignore messages from Signal groups
        if (incomingGroup) return { state }

        const phone = source

        if (attachments.length > 0) {
          ctx.pipeToSelf(
            (async () => {
              const copied: MessageAttachment[] = []
              for (const a of attachments) {
                const kind: MessageAttachment['kind'] =
                  a.contentType.startsWith('image/') ? 'image' :
                  a.contentType.startsWith('audio/') ? 'audio' :
                  a.contentType.startsWith('video/') ? 'video' :
                  a.contentType.includes('pdf')      ? 'pdf'   : 'file'
                const ext  = mimeToExt(a.contentType)
                const dest = join(INBOUND_DIR, `rorschach-${crypto.randomUUID()}.${ext}`)
                await mkdir(INBOUND_DIR, { recursive: true })
                await copyFile(`${attachmentsDir}/${a.id}`, dest)
                copied.push({ kind, url: dest, mimeType: a.contentType })
              }
              return copied
            })(),
            copied => ({ type: '_attachmentsCopied' as const, phone, text, messageAttachments: copied }),
            err => {
              ctx.log.error('signal: failed to copy attachments, proceeding without them', { error: String(err) })
              return { type: '_attachmentsCopied' as const, phone, text, messageAttachments: [] }
            }
          )
          return { state }
        }

        if (!text) return { state }
        return processIncomingMessage(state, phone, text, [], ctx)
      },

      _attachmentsCopied: (state, msg, ctx) => {
        return processIncomingMessage(state, msg.phone, msg.text, msg.messageAttachments, ctx)
      },

      _send: (state, msg, ctx) => {
        let ev: Record<string, unknown>
        try { ev = JSON.parse(msg.text) } catch { return { state } }

        const phones = state.userIdToPhones.get(msg.userId) ?? []
        let pending = new Map(state.pending)
        let activeSpans = { ...state.activeSpans }
        let stateChanged = false

        for (const phone of phones) {
          switch (ev.type) {
            case 'start':
            case 'reasoningChunk':
            case 'tooling':
            case 'chunk': {
              const isFirst = !pending.has(phone)
              if (isFirst) {
                sendTyping(phone)
                if (!ctx.timers.isActive('typing')) {
                  ctx.timers.startPeriodicTimer('typing', { type: '_refreshTyping' }, 10_000)
                }
              }
              const cur = pending.get(phone) ?? { text: '', attachments: [], sources: [] }
              if (ev.type === 'chunk') {
                pending.set(phone, { ...cur, text: cur.text + String(ev.text ?? '') })
              } else {
                pending.set(phone, cur)
              }
              stateChanged = true
              break
            }

            case 'attachments': {
              const incoming = (ev.attachments as MessageAttachment[] | undefined) ?? []
              if (incoming.length > 0) {
                const cur = pending.get(phone) ?? { text: '', attachments: [], sources: [] }
                pending.set(phone, { ...cur, attachments: [...cur.attachments, ...incoming] })
                stateChanged = true
              }
              break
            }

            case 'sources': {
              const incoming = (ev.sources as ToolSource[] | undefined) ?? []
              if (incoming.length > 0) {
                const cur = pending.get(phone) ?? { text: '', attachments: [], sources: [] }
                pending.set(phone, { ...cur, sources: [...cur.sources, ...incoming] })
                stateChanged = true
              }
              break
            }

            case 'done': {
              const buf = pending.get(phone)
              if (buf) {
                pending.delete(phone)
                sendTyping(phone, true)
                if (pending.size === 0) ctx.timers.cancel('typing')

                const rendered = renderForSignal(buf.text)
                const allAttachments = buf.attachments.map(a => join(MEDIA_DIR, a.url))

                const sendSeq = async () => {
                  if (rendered.message && allAttachments.length > 0) {
                    await sendOverSocket(phone, { message: '', textStyles: [] }, allAttachments)
                    await sendOverSocket(phone, rendered, [])
                  } else {
                    await sendOverSocket(phone, rendered, allAttachments)
                  }
                }

                ctx.pipeToSelf(
                  sendSeq(),
                  ()    => ({ type: '_sendOk'  as const }),
                  (err) => ({ type: '_sendErr' as const, error: String(err) }),
                )

                const span = activeSpans[phone]
                if (span) {
                  span.done()
                  delete activeSpans[phone]
                }
                stateChanged = true
              }
              break
            }

            case 'error': {
              const text = String(ev.text ?? 'unknown error')
              sendTyping(phone, true)
              pending.delete(phone)
              if (pending.size === 0) ctx.timers.cancel('typing')
              ctx.pipeToSelf(
                sendOverSocket(phone, { message: `⚠️ ${text}`, textStyles: [] }),
                ()    => ({ type: '_sendOk'  as const }),
                (err) => ({ type: '_sendErr' as const, error: String(err) }),
              )
              const errSpan = activeSpans[phone]
              if (errSpan) {
                errSpan.error(text)
                delete activeSpans[phone]
              }
              stateChanged = true
              break
            }
          }
        }

        return stateChanged ? { state: { ...state, pending, activeSpans } } : { state }
      },

      _identityProviderChanged: (state, msg) => ({
        state: { ...state, identityProviderRef: msg.ref },
      }),

      _phoneResolved: (state, msg, ctx) => {
        const { phone, userId } = msg
        const buffered = state.pendingConnect.get(phone) ?? []
        const pendingConnect = new Map(state.pendingConnect)
        pendingConnect.delete(phone)

        // Mark seen, then update mappings
        const seenIds = new Set(state.seenIds)
        seenIds.add(phone)

        const userIdToPhones = new Map(state.userIdToPhones)
        const currentPhones = userIdToPhones.get(userId) ?? []
        const isFirstConnection = currentPhones.length === 0
        userIdToPhones.set(userId, [...currentPhones.filter(p => p !== phone), phone])

        if (isFirstConnection) {
          ctx.publishRetained(UserPresenceTopic, userId, {
            status: 'present',
            userId,
            source: 'signal',
          })
        }

        refreshPresenceExpiry(phone, ctx)
        const events: ReturnType<typeof emit>[] = []
        let activeSpans = { ...state.activeSpans }
        for (const buf of buffered) {
          const span = ctx.trace.start('request', { clientId: phone })
          activeSpans = { ...activeSpans, [phone]: span }
          events.push(emit(InboundMessageTopic, {
            userId,
            text:         buf.text,
            attachments:  buf.attachments,
            traceId:      span.traceId,
            parentSpanId: span.spanId,
          }))
        }
        return { state: { ...state, seenIds, pendingConnect, activeSpans, userIdToPhones }, events }
      },

      _phoneRejected: (state, msg) => {
        const { phone } = msg
        const pendingConnect = new Map(state.pendingConnect)
        pendingConnect.delete(phone)
        writeToSocket(rpcLine('send', { ...(account ? { account } : {}), recipient: [phone], message: 'Please register on the web first.' })).catch(() => {})
        return { state: { ...state, pendingConnect } }
      },

      _presenceExpired: (state, msg, ctx) => {
        if (!state.seenIds.has(msg.phone)) return { state }
        const seenIds = new Set(state.seenIds)
        seenIds.delete(msg.phone)

        let userId = ''
        const userIdToPhones = new Map(state.userIdToPhones)
        for (const [uid, phones] of userIdToPhones.entries()) {
          if (phones.includes(msg.phone)) {
            userId = uid
            const remaining = phones.filter(p => p !== msg.phone)
            if (remaining.length === 0) {
              userIdToPhones.delete(uid)
            } else {
              userIdToPhones.set(uid, remaining)
            }
            break
          }
        }

        const events = []
        if (userId && !userIdToPhones.has(userId)) {
          events.push(emit(UserPresenceTopic, {
            status: 'absent',
            userId,
            source: 'signal',
          }))
        }

        return { state: { ...state, seenIds, userIdToPhones }, events }
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
