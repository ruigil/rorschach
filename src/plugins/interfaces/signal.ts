import { tmpdir } from 'node:os'
import type { ActorDef } from '../../system/types.ts'
import { onLifecycle, onMessage } from '../../system/match.ts'
import { emit } from '../../system/types.ts'
import { WsConnectTopic, WsMessageTopic, WsSendTopic } from '../../system/topics.ts'

// ─── Markdown → Signal formatting ───
//
// signal-cli `send` accepts plain `message` text + `textStyles` array of "start:length:STYLE".
// This function strips all markdown markers, produces clean plain text, and tracks
// the byte-offset ranges for BOLD, ITALIC, STRIKETHROUGH, and MONOSPACE.
//
export type SignalFormatted = { message: string; textStyles: string[] }

const renderForSignal = (md: string): SignalFormatted => {
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
  url?:             string  // JSON-RPC endpoint, default: 'http://127.0.0.1:7583/api/v1/rpc'
  account?:         string  // Signal account phone number
  pollIntervalMs?:  number  // how often to call receive, default: 2000
  attachmentsDir?:  string  // where signal-cli stores downloaded attachments
}

// ─── Message protocol ───

type Attachment = { id: string; contentType: string }

type Envelope = {
  source?:       string
  sourceNumber?: string
  dataMessage?:  { message?: string; attachments?: Attachment[] }
  syncMessage?:  { sentMessage?: { destination?: string; destinationNumber?: string; message?: string; attachments?: Attachment[] } }
}

type IncomingMsg = { source: string; text: string; attachments: Attachment[] }

type SignalMsg =
  | { type: '_poll' }
  | { type: '_pollResult';      envelopes: Envelope[] }
  | { type: '_pollErr';         error: string }
  | { type: '_attachmentsRead'; msg: IncomingMsg; filePaths: string[] }
  | { type: '_send';            clientId: string; text: string }
  | { type: '_sendOk' }
  | { type: '_sendErr';         error: string }
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
  const url            = options?.url            ?? 'http://127.0.0.1:7583/api/v1/rpc'
  const account        = options?.account        ?? null
  const pollMs         = options?.pollIntervalMs ?? 2_000
  const attachmentsDir = options?.attachmentsDir ?? `${process.env.HOME}/.local/share/signal-cli/attachments`

  let msgId = 0

  const rpc = async (method: string, params: Record<string, unknown>): Promise<unknown> => {
    const id   = ++msgId
    const body = JSON.stringify({ jsonrpc: '2.0', id, method, params })
    const res  = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })
    return res.json()
  }

  const send = (recipient: string, { message, textStyles }: SignalFormatted) =>
    rpc('send', {
      ...(account ? { account } : {}),
      recipient: [recipient],
      message,
      ...(textStyles.length > 0 ? { textStyles } : {}),
    })

  // Fire-and-forget — typing indicators are best-effort, no state implications
  const sendTyping = (recipient: string, stop = false) =>
    rpc('sendTyping', { ...(account ? { account } : {}), recipient: [recipient], stop })
      .catch(() => {})

  // `receive` does not accept an account param — it reads from the daemon's active account
  const pollReceive = async (): Promise<Envelope[]> => {
    const res: any = await rpc('receive', {})
    const items: any[] = Array.isArray(res) ? res : (res?.result ?? [])
    return items.flatMap(r => r?.envelope ? [r.envelope as Envelope] : [])
  }

  // Copy each attachment to a temp file so the vision actor can read + delete it
  // without touching signal-cli's own attachments directory.
  const resolveAttachments = (attachments: Attachment[]): Promise<string[]> =>
    Promise.all(attachments.map(async a => {
      const src     = `${attachmentsDir}/${a.id}`
      const ext     = a.contentType.split('/')[1] ?? 'jpeg'
      const tmpPath = `${tmpdir()}/rorschach-${crypto.randomUUID()}.${ext}`
      await Bun.write(tmpPath, Bun.file(src))
      return tmpPath
    }))

  return {
    lifecycle: onLifecycle({
      start: (state, ctx) => {
        ctx.subscribe(WsSendTopic, e => ({ type: '_send' as const, clientId: e.clientId, text: e.text }))
        ctx.timers.startPeriodicTimer('poll', { type: '_poll' }, pollMs)
        ctx.log.info(`signal actor polling ${url} every ${pollMs}ms`)
        return { state }
      },

      stopped: (state, ctx) => {
        ctx.timers.cancel('poll')
        ctx.log.info('signal actor stopped')
        return { state }
      },
    }),

    handler: onMessage<SignalMsg, SignalState>({
      _poll: (state, _msg, ctx) => {
        ctx.pipeToSelf(
          pollReceive(),
          envelopes => ({ type: '_pollResult' as const, envelopes }),
          err       => ({ type: '_pollErr'    as const, error: String(err) }),
        )
        return { state }
      },

      _pollResult: (state, msg, ctx) => {
        const events  = []
        const seenIds = new Set(state.seenIds)

        for (const envelope of msg.envelopes) {
          const sent        = envelope.syncMessage?.sentMessage
          const source      = envelope.source ?? envelope.sourceNumber ?? sent?.destination ?? sent?.destinationNumber
          const text        = envelope.dataMessage?.message ?? sent?.message ?? ''
          const attachments = envelope.dataMessage?.attachments ?? sent?.attachments ?? []

          if (!source || (!text && attachments.length === 0)) continue

          if (!seenIds.has(source)) {
            seenIds.add(source)
            events.push(emit(WsConnectTopic, { clientId: source }))
          }

          const incoming: IncomingMsg = { source, text, attachments }

          if (attachments.length > 0) {
            ctx.pipeToSelf(
              resolveAttachments(attachments),
              filePaths => ({ type: '_attachmentsRead' as const, msg: incoming, filePaths }),
              ()        => ({ type: '_attachmentsRead' as const, msg: incoming, filePaths: [] }),
            )
          } else {
            events.push(emit(WsMessageTopic, {
              clientId:     source,
              text,
              traceId:      crypto.randomUUID(),
              parentSpanId: crypto.randomUUID(),
            }))
          }
        }

        return { state: { ...state, seenIds }, events }
      },

      _attachmentsRead: (state, msg) => ({
        state,
        events: [emit(WsMessageTopic, {
          clientId:     msg.msg.source,
          text:         msg.msg.text,
          images:       msg.filePaths.length > 0 ? msg.filePaths : undefined,
          traceId:      crypto.randomUUID(),
          parentSpanId: crypto.randomUUID(),
        })],
      }),

      _pollErr: (state, msg, ctx) => {
        ctx.log.error(`signal: poll failed: ${msg.error}`)
        return { state }
      },

      _send: (state, msg, ctx) => {
        let ev: Record<string, unknown>
        try { ev = JSON.parse(msg.text) } catch { return { state } }

        switch (ev.type) {
          case 'chunk': {
            const isFirst = !state.pending.has(msg.clientId)
            if (isFirst) {
              sendTyping(msg.clientId)
              // start refresh timer if not already running
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
              send(msg.clientId, renderForSignal(raw)),
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
              send(msg.clientId, { message: `⚠️ ${text}`, textStyles: [] }),
              ()    => ({ type: '_sendOk'  as const }),
              (err) => ({ type: '_sendErr' as const, error: String(err) }),
            )
            return { state }
          }

          default:
            return { state }
        }
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
