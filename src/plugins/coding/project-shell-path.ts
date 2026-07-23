/** Soft cap for text returned to the coding agent (after sandbox limits). */
export const MAX_TOOL_RESULT_CHARS = 80_000

/** Default number of lines returned by the read tool. */
export const DEFAULT_READ_LINE_LIMIT = 300

/** Hard upper bound on read limit (even if the model requests more). */
export const MAX_READ_LINE_LIMIT = 2_000

export const WORKSPACE_MOUNT = '/workspace'

/** Truncate agent-facing tool text with an explicit remainder marker. */
export const truncateForAgent = (text: string, maxChars = MAX_TOOL_RESULT_CHARS): string => {
  if (text.length <= maxChars) return text
  const omitted = text.length - maxChars
  return `${text.slice(0, maxChars)}\n… [truncated ${omitted} chars]`
}

/**
 * Normalize an absolute virtual path (collapse `.` / `..`).
 * Returns null if the path is relative or escapes past root via `..`.
 */
export const normalizeVirtualPath = (raw: string): string | null => {
  const trimmed = raw.trim()
  if (!trimmed.startsWith('/')) return null

  const stack: string[] = []
  for (const part of trimmed.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (stack.length === 0) return null
      stack.pop()
      continue
    }
    stack.push(part)
  }
  return stack.length === 0 ? '/' : `/${stack.join('/')}`
}

/** True if path is under the project mount or /workspace. */
export const isAllowedMountPath = (path: string, projectMount: string): boolean => {
  const mount = projectMount === '/' ? '/' : projectMount.replace(/\/+$/, '') || '/'
  if (mount === '/') return path.startsWith('/')
  if (path === mount || path.startsWith(`${mount}/`)) return true
  if (path === WORKSPACE_MOUNT || path.startsWith(`${WORKSPACE_MOUNT}/`)) return true
  return false
}

/**
 * Normalize and require path under project mount or /workspace.
 */
export const resolveAllowedPath = (
  raw: string,
  projectMount: string,
  label = 'Path',
): { ok: true; path: string } | { ok: false; error: string } => {
  const normalized = normalizeVirtualPath(raw)
  if (!normalized) {
    return { ok: false, error: `Invalid path: ${raw}` }
  }
  if (!isAllowedMountPath(normalized, projectMount)) {
    return {
      ok: false,
      error: `${label} must be under ${projectMount} or ${WORKSPACE_MOUNT}: ${normalized}`,
    }
  }
  return { ok: true, path: normalized }
}

export type LineWindow = {
  body: string
  startLine: number
  endLine: number
  totalLines: number
  truncatedByLines: boolean
}

/** Slice file content into a 1-based line window. */
export const sliceLineWindow = (content: string, offset = 1, limit = DEFAULT_READ_LINE_LIMIT): LineWindow => {
  const lines = content === '' ? [] : content.split('\n')
  const totalLines = lines.length
  const startLine = Number.isFinite(offset) ? Math.max(1, Math.floor(offset)) : 1
  const cappedLimit = Number.isFinite(limit)
    ? Math.min(MAX_READ_LINE_LIMIT, Math.max(1, Math.floor(limit)))
    : DEFAULT_READ_LINE_LIMIT

  if (totalLines === 0) {
    return { body: '', startLine: 1, endLine: 0, totalLines: 0, truncatedByLines: false }
  }

  const startIdx = Math.min(startLine - 1, totalLines)
  const slice = lines.slice(startIdx, startIdx + cappedLimit)
  const endLine = startIdx + slice.length
  const truncatedByLines = startIdx > 0 || endLine < totalLines

  return {
    body: slice.join('\n'),
    startLine: startIdx + 1,
    endLine,
    totalLines,
    truncatedByLines,
  }
}

/** Format one content line with absolute 1-based line number prefix (`N|…`). */
export const formatNumberedLine = (lineNo: number, text: string, width: number): string =>
  `${String(lineNo).padStart(Math.max(1, width), ' ')}|${text}`

/** Prefix each line of a window body with absolute file line numbers. */
export const numberLineWindowBody = (body: string, startLine: number, endLine: number): string => {
  if (body === '' && endLine < startLine) return ''
  const width = String(Math.max(endLine, startLine, 1)).length
  const lines = body.split('\n')
  return lines.map((line, i) => formatNumberedLine(startLine + i, line, width)).join('\n')
}

/** Format a read-tool payload with path/line metadata for the agent. */
export const formatReadResult = (path: string, content: string, offset?: number, limit?: number): string => {
  const window = sliceLineWindow(content, offset ?? 1, limit ?? DEFAULT_READ_LINE_LIMIT)
  const header =
    window.totalLines === 0
      ? `// path: ${path}\n// empty file\n`
      : `// path: ${path}\n// lines ${window.startLine}-${window.endLine} of ${window.totalLines}\n`

  const numberedBody =
    window.totalLines === 0
      ? ''
      : numberLineWindowBody(window.body, window.startLine, window.endLine)

  let text = header + numberedBody
  if (window.truncatedByLines && window.endLine < window.totalLines) {
    text += `\n// … truncated; use offset=${window.endLine + 1} to continue`
  } else if (window.truncatedByLines && window.startLine > 1) {
    text += `\n// … showing mid-file window`
  }

  return truncateForAgent(text)
}
