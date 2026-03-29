import type { ActorDef } from '../../system/types.ts'
import { onLifecycle, onMessage } from '../../system/match.ts'
import {
  WsConnectTopic,
  WsDisconnectTopic,
  WsMessageTopic,
  WsSendTopic,
} from '../../types/ws.ts'

// ─── ANSI codes ───
const C = {
  reset:     '\x1b[0m',
  bold:      '\x1b[1m',
  dim:       '\x1b[2m',
  italic:    '\x1b[3m',
  underline: '\x1b[4m',
  rev:       '\x1b[7m',
  red:       '\x1b[31m',
  green:     '\x1b[32m',
  yellow:    '\x1b[33m',
  blue:      '\x1b[34m',
  magenta:   '\x1b[35m',
  cyan:      '\x1b[36m',
  bgOrange:   '\x1b[48;5;208m',
  bgDarkGrey: '\x1b[48;5;236m',
  fgBlack:    '\x1b[30m',
  fgWhite:    '\x1b[97m',
  fgNavy:     '\x1b[38;5;18m',
}

const CLI_CLIENT_ID = 'cli'

// Fixed bottom section (5 lines, outside the scroll region):
//   R-4 : blue separator above prompt
//   R-3 : prompt line  (› <input>)
//   R-2 : blue separator below prompt
//   R-1 : status bar
//   R   : blank line below status
const FIXED = 5

const blueSep = () => `\x1b[34m${'─'.repeat(process.stdout.columns ?? 80)}${C.reset}`

// ─── Message protocol ───
type CliMsg =
  | { type: '_send';      clientId: string; text: string }
  | { type: '_userInput'; text: string }

// ─── State ───
export type CliState = {
  connected:        boolean
  status:           'idle' | 'waiting'
  pendingText:      string
  streamedRows:     number   // rows used by current streaming response
  streamingCol:     number   // current column during streaming (0-indexed)
  responseStartSEnd: number  // value of sEnd() when the current response started
  model:            string | null
  inputTokens:      number
  outputTokens:     number
  contextPercent:   number | null
  sessionCost:      number | null
}

export const CLI_INITIAL_STATE: CliState = {
  connected: false, status: 'idle', pendingText: '', streamedRows: 0, streamingCol: 0, responseStartSEnd: 0,
  model: null, inputTokens: 0, outputTokens: 0, contextPercent: null, sessionCost: null,
}

// ─── Terminal helpers ───
const R    = () => process.stdout.rows    ?? 24
const sEnd = () => R() - FIXED             // last row of the scroll region (1-indexed)

// ─── Inline markdown → ANSI ───
function inlineMd(text: string): string {
  return text
    .replace(/\*\*\*(.+?)\*\*\*/gs, `${C.cyan}${C.bold}${C.italic}$1${C.reset}`)
    .replace(/\*\*(.+?)\*\*/gs,     `${C.cyan}${C.bold}$1${C.reset}`)
    .replace(/\*(.+?)\*/gs,         `${C.italic}$1${C.reset}`)
    .replace(/_(.+?)_/gs,           `${C.italic}$1${C.reset}`)
    .replace(/`([^`]+)`/g,          `${C.yellow}$1${C.reset}`)
}

// Strip ANSI escape codes to get the visible display width of a string.
function visibleLen(s: string): number {
  return s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\t/g, '    ').length
}

// ─── Pipe-table renderer ───
function renderTable(rows: string[][]): string[] {
  const isSep = (cells: string[]) => cells.every(c => /^[-: ]+$/.test(c))
  const dataRows = rows.filter(r => !isSep(r))
  if (dataRows.length === 0) return []

  const colCount = Math.max(...dataRows.map(r => r.length))
  const colWidths = Array.from({ length: colCount }, (_, i) =>
    Math.max(...dataRows.map(r => visibleLen(inlineMd(r[i]?.trim() ?? ''))))
  )

  const bar = (l: string, m: string, r: string) =>
    `${C.dim}${l}${colWidths.map(w => '─'.repeat(w + 2)).join(m)}${r}${C.reset}`

  const renderRow = (cells: string[]) =>
    `${C.dim}│${C.reset}` +
    Array.from({ length: colCount }, (_, i) => {
      const rendered = inlineMd(cells[i]?.trim() ?? '')
      const pad = colWidths[i]! - visibleLen(rendered)
      return ` ${rendered}${' '.repeat(Math.max(0, pad))} ${C.dim}│${C.reset}`
    }).join('')

  const out: string[] = [bar('┌', '┬', '┐')]
  dataRows.forEach((row, i) => {
    out.push(renderRow(row))
    if (i === 0 && dataRows.length > 1) out.push(bar('├', '┼', '┤'))
  })
  out.push(bar('└', '┴', '┘'))
  return out
}

// ─── Block markdown → ANSI ───
function renderMarkdown(text: string): string {
  const lines = text.split('\n')
  const out: string[] = []
  let inCode = false
  let codeLang = ''
  let tableRows: string[][] = []

  const flushTable = () => {
    if (tableRows.length > 0) { out.push(...renderTable(tableRows)); tableRows = [] }
  }

  for (const line of lines) {
    const fence = line.match(/^```(\w*)/)
    if (fence) {
      flushTable()
      if (!inCode) {
        inCode   = true
        codeLang = fence[1] || 'code'
        out.push(`${C.dim}┌─ ${codeLang} ${'─'.repeat(Math.max(0, 38 - codeLang.length))}${C.reset}`)
      } else {
        inCode = false
        out.push(`${C.dim}└${'─'.repeat(42)}${C.reset}`)
      }
      continue
    }
    if (inCode) { out.push(`${C.dim}│${C.reset} ${C.yellow}${line}${C.reset}`); continue }

    // Pipe-table row: starts with | and has at least one more |
    if (line.startsWith('|') && line.lastIndexOf('|') > 0) {
      const cells = line.split('|').slice(1, -1).map(c => c.trim())
      tableRows.push(cells)
      continue
    }
    flushTable()

    const h6 = line.match(/^###### (.+)/)
    const h5 = line.match(/^##### (.+)/)
    const h4 = line.match(/^#### (.+)/)
    const h3 = line.match(/^### (.+)/)
    const h2 = line.match(/^## (.+)/)
    const h1 = line.match(/^# (.+)/)
    if (h1) { out.push(`${C.magenta}${C.bold}${C.underline}${inlineMd(h1[1]!)}${C.reset}`); continue }
    if (h2) { out.push(`${C.magenta}${C.bold}${inlineMd(h2[1]!)}${C.reset}`);               continue }
    if (h3) { out.push(`${C.magenta}${inlineMd(h3[1]!)}${C.reset}`);                        continue }
    if (h4) { out.push(`${C.cyan}${C.bold}${inlineMd(h4[1]!)}${C.reset}`);                  continue }
    if (h5) { out.push(`${C.cyan}${inlineMd(h5[1]!)}${C.reset}`);                           continue }
    if (h6) { out.push(`${C.dim}${inlineMd(h6[1]!)}${C.reset}`);                            continue }

    if (line.startsWith('> ')) { out.push(`${C.dim}│ ${inlineMd(line.slice(2))}${C.reset}`); continue }

    const li = line.match(/^(\s*)[-*+] (.+)/)
    if (li) { out.push(`${li[1]!}${C.cyan}•${C.reset} ${inlineMd(li[2]!)}`); continue }

    const num = line.match(/^(\s*)(\d+)\. (.+)/)
    if (num) { out.push(`${num[1]!}${C.dim}${num[2]!}.${C.reset} ${inlineMd(num[3]!)}`); continue }

    if (/^[-*_]{3,}$/.test(line.trim())) { out.push(`${C.dim}${'─'.repeat(44)}${C.reset}`); continue }

    out.push(line.length > 0 ? inlineMd(line) : '')
  }
  flushTable()
  return out.join('\n')
}

// ─── Fixed area ───
// Uses save/restore cursor so callers need not track cursor position.
function drawFixed(state: CliState, inputBuf: string): void {
  const r = R()
  const dot   = state.status === 'idle' ? `${C.green}●${C.reset}` : `${C.yellow}⟳${C.reset}`
  const label = state.status === 'idle' ? 'connected' : 'thinking…'
  const model  = state.model ? `  ${C.dim}${state.model}${C.reset}` : ''
  const tokens = state.inputTokens > 0
    ? `  ${C.dim}↑${state.inputTokens} ↓${state.outputTokens}${C.reset}`
    : ''
  const ctx = state.contextPercent != null
    ? `  ${C.dim}ctx ${Math.round(state.contextPercent * 100)}%${C.reset}`
    : ''
  const cost = state.sessionCost != null
    ? `  ${C.dim}$${state.sessionCost < 0.01 ? state.sessionCost.toFixed(4) : state.sessionCost.toFixed(2)}${C.reset}`
    : ''
  process.stdout.write(
    `\x1b[s` +
    `\x1b[${r - 4};1H\x1b[2K${blueSep()}` +
    `\x1b[${r - 3};1H\x1b[2K${C.bold}›${C.reset} ${inputBuf}` +
    `\x1b[${r - 2};1H\x1b[2K${blueSep()}` +
    `\x1b[${r - 1};1H\x1b[2K${dot} ${label}${model}${tokens}${ctx}${cost}` +
    `\x1b[${r};1H\x1b[2K` +
    `\x1b[u`,
  )
}

// Position cursor after the current input on the prompt line.
function cursorToPrompt(inputBuf: string): void {
  process.stdout.write(`\x1b[${R() - 3};${3 + inputBuf.length}H`)
}

// ─── Scroll-area helpers (all use save/restore, leave cursor at prompt) ───

// Overwrite the last line of the scroll region.
function setScrollEnd(text: string): void {
  process.stdout.write(`\x1b[s\x1b[${sEnd()};1H\x1b[2K${text}\x1b[u`)
}

// Append one or more lines: each triggers a scroll-up within the scroll region.
function appendScroll(lines: string[]): void {
  if (lines.length === 0) return
  let out = `\x1b[s\x1b[${sEnd()};1H`
  for (const line of lines) out += `\n\x1b[2K${line}`
  out += '\x1b[u'
  process.stdout.write(out)
}

// ─── Actor factory ───
export const createCliActor = (): ActorDef<CliMsg, CliState> => {
  let inputBuf     = ''
  let currentState: CliState = { ...CLI_INITIAL_STATE }

  function redrawPromptLine(): void {
    const r = R()
    process.stdout.write(
      `\x1b[${r - 3};1H\x1b[2K${C.bold}›${C.reset} ${inputBuf}` +
      `\x1b[${r - 3};${3 + inputBuf.length}H`,
    )
  }

  return {
    lifecycle: onLifecycle({
      start: (state, ctx) => {
        currentState = state

        ctx.subscribe(WsSendTopic, e => ({ type: '_send' as const, clientId: e.clientId, text: e.text }))

        // ─── Raw-mode stdin ───
        if (process.stdin.isTTY) process.stdin.setRawMode(true)
        process.stdin.resume()
        process.stdin.setEncoding('utf8')

        process.stdin.on('data', (key: string) => {
          // Ctrl+C → graceful shutdown
          if (key === '\x03') { process.kill(process.pid, 'SIGINT'); return }

          // Enter
          if (key === '\r' || key === '\n') {
            const text = inputBuf.trim()
            if (text && currentState.status === 'idle') {
              ctx.self.send({ type: '_userInput' as const, text })
            }
            return
          }

          // Backspace
          if (key === '\x7f' || key === '\b') {
            if (inputBuf.length > 0 && currentState.status === 'idle') {
              inputBuf = inputBuf.slice(0, -1)
              redrawPromptLine()
            }
            return
          }

          // Ignore escape sequences (arrow keys, function keys…)
          if (key.startsWith('\x1b')) return

          // Printable character
          if (key.length === 1 && key.charCodeAt(0) >= 32 && currentState.status === 'idle') {
            inputBuf += key
            process.stdout.write(key)  // echo directly; cursor advances on prompt line
          }
        })

        // ─── Terminal setup ───
        process.stdout.write(
          `\x1b[1;${sEnd()}r` +  // set scroll region
          `\x1b[2J`,             // clear screen
        )
        drawFixed(state, inputBuf)
        cursorToPrompt(inputBuf)

        // Redraw on resize
        process.stdout.on('resize', () => {
          process.stdout.write(`\x1b[1;${sEnd()}r`)
          drawFixed(currentState, inputBuf)
          cursorToPrompt(inputBuf)
        })

        return { state }
      },

      stopped: (state, ctx) => {
        if (state.connected) ctx.publish(WsDisconnectTopic, { clientId: CLI_CLIENT_ID })
        process.stdout.write('\x1b[r\x1b[2J\x1b[H')  // reset scroll region, clear, home
        if (process.stdin.isTTY) process.stdin.setRawMode(false)
        return { state }
      },
    }),

    handler: onMessage<CliMsg, CliState>({
      _userInput: (state, message, ctx) => {
        if (state.status === 'waiting') return { state }

        if (!state.connected) ctx.publish(WsConnectTopic, { clientId: CLI_CLIENT_ID })

        ctx.publish(WsMessageTopic, {
          clientId: CLI_CLIENT_ID,
          text:     message.text,
          traceId:  crypto.randomUUID(),
          parentSpanId: crypto.randomUUID(),
        })

        // Show user message (reversed bg) then thinking indicator in scroll area
        appendScroll([
          `${C.bgDarkGrey}${' '.repeat(process.stdout.columns ?? 80)}${C.reset}`,
          `${C.bgDarkGrey}${C.fgWhite}${C.bold} › ${message.text}${' '.repeat(Math.max(1, (process.stdout.columns ?? 80) - 3 - message.text.length))}${C.reset}`,
          `${C.bgDarkGrey}${' '.repeat(process.stdout.columns ?? 80)}${C.reset}`,
          `${C.dim}⟳ thinking…${C.reset}`,
        ])

        inputBuf = ''
        const next: CliState = { ...state, connected: true, status: 'waiting', pendingText: '', streamedRows: 1, streamingCol: 0, responseStartSEnd: sEnd() }
        currentState = next
        drawFixed(next, inputBuf)
        // Leave cursor at the thinking line — chunks will overwrite it directly
        process.stdout.write(`\x1b[${sEnd()};1H`)

        return { state: next }
      },

      _send: (state, message) => {
        if (message.clientId !== CLI_CLIENT_ID) return { state }

        let ev: Record<string, unknown>
        try { ev = JSON.parse(message.text) } catch { return { state } }

        switch (ev.type) {

          // ─── Stream tokens directly to the scroll area ───
          case 'chunk': {
            const text = String(ev.text ?? '')
            if (!text) return { state }
            // First chunk: clear the "⟳ thinking…" line (cursor is at sEnd();col 1)
            if (!state.pendingText) process.stdout.write('\r\x1b[K')
            // Raw mode disables OPOST so \n is bare LF (no col reset).
            // Normalize to \r\n so the column resets on each newline.
            process.stdout.write(text.replace(/\r?\n/g, '\r\n'))
            // Track exact row/col so done handler can clear precisely
            const cols = process.stdout.columns ?? 80
            let col  = state.streamingCol
            let rows = state.streamedRows
            for (const ch of text) {
              if      (ch === '\n') { rows++; col = 0 }
              else if (ch === '\r') { col = 0 }
              else { col++; if (col >= cols) { col = 0; rows++ } }
            }
            const next: CliState = { ...state, pendingText: state.pendingText + text, streamedRows: rows, streamingCol: col }
            currentState = next
            return { state: next }
          }

          // ─── Tool call — replace thinking line, add new thinking below ───
          case 'searching': {
            const tools = (ev.tools as string[]).join(', ')
            setScrollEnd(`${C.cyan}⚙${C.reset} ${C.dim}${tools}…${C.reset}`)
            appendScroll([`${C.dim}⟳ thinking…${C.reset}`])
            // Reposition cursor at the new thinking line so the next chunk's \r\x1b[K clears it.
            // Also reset tracking so done handler uses this segment's row count.
            process.stdout.write(`\x1b[${sEnd()};1H`)
            const next: CliState = { ...state, pendingText: '', streamedRows: 1, streamingCol: 0, responseStartSEnd: sEnd() }
            currentState = next
            return { state: next }
          }

          // ─── LLM done — overwrite raw stream with markdown-rendered version ───
          case 'done': {
            if (!state.pendingText) {
              process.stdout.write(`\x1b[${sEnd()};1H\x1b[2K`)
              cursorToPrompt(inputBuf)
              return { state }
            }

            const rendered = renderMarkdown(state.pendingText)
            const renderedLines = rendered.split('\n')
            while (renderedLines.length > 0 && renderedLines[renderedLines.length - 1] === '') renderedLines.pop()
            renderedLines.push('')  // blank separator

            // Use responseStartSEnd (sEnd() captured when this segment started) so a terminal
            // resize between stream-start and done doesn't shift startRow into the wrong place.
            const startRow = Math.max(1, state.responseStartSEnd - state.streamedRows + 1)

            // Clear the streamed rows then re-render from startRow
            let out = ''
            for (let row = startRow; row <= sEnd(); row++) out += `\x1b[${row};1H\x1b[2K`
            out += `\x1b[${startRow};1H${renderedLines[0] ?? ''}`
            for (let i = 1; i < renderedLines.length; i++) out += `\n\x1b[2K${renderedLines[i]!}`
            process.stdout.write(out)

            cursorToPrompt(inputBuf)
            return { state }
          }

          // ─── Usage — update token counts in the status bar only ───
          case 'usage': {
            const inputTokens   = Number(ev.inputTokens   ?? 0)
            const outputTokens  = Number(ev.outputTokens  ?? 0)
            const model         = String(ev.model ?? state.model ?? '')
            const contextPercent = ev.contextPercent != null ? Number(ev.contextPercent) : null
            const sessionCost    = ev.sessionCost    != null ? Number(ev.sessionCost)    : null
            const next: CliState = { ...state, status: 'idle', pendingText: '', streamedRows: 0, streamingCol: 0, responseStartSEnd: 0, model, inputTokens, outputTokens, contextPercent, sessionCost }
            currentState = next
            drawFixed(next, inputBuf)
            cursorToPrompt(inputBuf)
            return { state: next }
          }

          // ─── Error ───
          case 'error': {
            setScrollEnd(`${C.red}✗ ${String(ev.text ?? 'Unknown error')}${C.reset}`)
            const next: CliState = { ...state, status: 'idle', pendingText: '' }
            currentState = next
            drawFixed(next, inputBuf)
            cursorToPrompt(inputBuf)
            return { state: next }
          }

          default:
            return { state }
        }
      },
    }),
  }
}
