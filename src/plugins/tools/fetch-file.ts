import { join } from 'node:path'
import { mkdir } from 'node:fs/promises'
import type { ActorDef, ActorRef, SpanHandle } from '../../system/types.ts'
import { onMessage } from '../../system/match.ts'
import type { ToolInvokeMsg, ToolReply, ToolSchema } from '../../types/tools.ts'

const INBOUND_DIR = join(import.meta.dir, '../../..', 'workspace/media/inbound')

export const FETCH_FILE_TOOL_NAME = 'fetch_file'

export const FETCH_FILE_SCHEMA: ToolSchema = {
  type: 'function',
  function: {
    name: FETCH_FILE_TOOL_NAME,
    description:
      'Download a file from a URL to a local temp path and return the path. ' +
      'Works with PDFs, images (jpeg, png, gif, webp, …), audio, and any other binary or text file. ' +
      'Use the returned path with other tools such as extract_pdf_text or analyze_image.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The URL of the file to download' },
      },
      required: ['url'],
    },
  },
}

export type FetchFileMsg =
  | ToolInvokeMsg
  | { type: '_done'; url: string; filePath: string; contentType: string; bytes: number; replyTo: ActorRef<ToolReply>; span: SpanHandle | null }
  | { type: '_err'; url: string; error: string; replyTo: ActorRef<ToolReply>; span: SpanHandle | null }

type FetchFileArgs = { url: string }

const guessExtension = (contentType: string, url: string): string => {
  const ct = (contentType.split(';')[0] ?? '').trim().toLowerCase()
  const extMap: Record<string, string> = {
    'application/pdf':       'pdf',
    'image/jpeg':            'jpg',
    'image/png':             'png',
    'image/gif':             'gif',
    'image/webp':            'webp',
    'image/svg+xml':         'svg',
    'audio/mpeg':            'mp3',
    'audio/wav':             'wav',
    'audio/ogg':             'ogg',
    'video/mp4':             'mp4',
    'text/html':             'html',
    'text/plain':            'txt',
    'application/json':      'json',
    'application/zip':       'zip',
  }
  if (extMap[ct]) return extMap[ct]
  const urlExt = url.split('?')[0]?.split('#')[0]?.split('.').pop()
  return urlExt && urlExt.length <= 5 && /^[a-zA-Z0-9]+$/.test(urlExt) ? urlExt : 'bin'
}

const sanitizeBasename = (name: string): string => {
  return name
    .replace(/[/\\:*?\"<>|]/g, '_')
    .replace(/\r?\n/g, '')
    .replace(/\t/g, '_')
    .replace(/^\u002e+|\u002e+$/g, '')
    .replace(/\u002e{2,}/g, '.')
}

const extractBasenameFromUrl = (urlStr: string): string => {
  try {
    const url = new URL(urlStr)
    const segments = url.pathname.split('/').filter(Boolean)
    const last = segments[segments.length - 1] ?? ''
    const decoded = decodeURIComponent(last)
    if (!decoded || decoded === '.' || decoded === '..' || /[/\\]/.test(decoded)) return ''
    const sanitized = sanitizeBasename(decoded)
    return sanitized.length > 0 ? sanitized : ''
  } catch {
    return ''
  }
}

const resolveUniquePath = async (dir: string, basename: string): Promise<string> => {
  const { stat } = await import('node:fs/promises')
  let candidate = join(dir, basename)
  try { await stat(candidate); } catch { return candidate }

  const dotIdx = basename.lastIndexOf('.')
  const hasExt = dotIdx > 0 && dotIdx < basename.length - 1
  const name = hasExt ? basename.slice(0, dotIdx) : basename
  const ext   = hasExt ? basename.slice(dotIdx) : ''

  for (let i = 1; i < 1000; i++) {
    candidate = join(dir, `${name}-${i}${ext}`)
    try { await stat(candidate); } catch { return candidate }
  }

  candidate = join(dir, `${name}-${crypto.randomUUID()}${ext}`)
  return candidate
}

const downloadFile = async (args: FetchFileArgs): Promise<{ filePath: string; contentType: string; bytes: number }> => {
  const res = await fetch(args.url)
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${await res.text()}`)
  }

  const contentType = res.headers.get('content-type') ?? ''
  const urlExt      = guessExtension(contentType, args.url)

  const originalName = extractBasenameFromUrl(args.url)
  let baseName: string
  if (originalName) {
    const dotIdx    = originalName.lastIndexOf('.')
    const hasDotExt = dotIdx > 0 && dotIdx < originalName.length - 1
    const guessedExt = guessExtension(contentType, args.url)
    const sameExt  = hasDotExt && originalName.slice(dotIdx + 1) === guessedExt
    baseName = sameExt ? originalName : `${originalName}.${guessedExt}`
  } else {
    baseName = `rorschach-${crypto.randomUUID()}.${urlExt}`
  }

  await mkdir(INBOUND_DIR, { recursive: true })
  const filePath = await resolveUniquePath(INBOUND_DIR, baseName)

  const buffer = await res.arrayBuffer()
  await Bun.write(filePath, buffer)

  return { filePath, contentType, bytes: buffer.byteLength }
}

// ─── Actor definition ───

export const createFetchFileActor = (): ActorDef<FetchFileMsg, null> => ({
  handler: onMessage<FetchFileMsg, null>({
    invoke: (state, message, ctx) => {
      const { arguments: rawArgs, replyTo } = message
      let args: FetchFileArgs = { url: '' }
      try { args = JSON.parse(rawArgs) as FetchFileArgs } catch { args = { url: rawArgs } }

      const parent = ctx.trace.fromHeaders()
      const span: SpanHandle | null = parent
        ? ctx.trace.child(parent.traceId, parent.spanId, 'fetch-file', { url: args.url })
        : null

      ctx.pipeToSelf(
        downloadFile(args),
        ({ filePath, contentType, bytes }) => ({ type: '_done' as const, url: args.url, filePath, contentType, bytes, replyTo, span }),
        (error) => ({ type: '_err' as const, url: args.url, error: String(error), replyTo, span }),
      )
      return { state }
    },

    _done: (state, message) => {
      const { filePath, contentType, bytes, replyTo, span } = message
      span?.done({ bytes, filePath })
      replyTo.send({ type: 'toolResult', result: `Downloaded to: ${filePath} (${contentType}, ${bytes} bytes)` })
      return { state }
    },

    _err: (state, message, ctx) => {
      const { url, error, replyTo, span } = message
      ctx.log.error('fetch file failed', { url, error })
      span?.error(error)
      replyTo.send({ type: 'toolError', error })
      return { state }
    },
  }),

  supervision: { type: 'restart', maxRetries: 3, withinMs: 30_000 },
})
