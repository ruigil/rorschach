import type { ActorDef, ActorRef, SpanHandle } from '../../system/index.ts'
import { onMessage, onLifecycle, ask } from '../../system/index.ts'
import { defineTool } from '../../system/index.ts'
import type { ToolInvokeMsg, ToolReply } from '../../types/tools.ts'
import { PersistenceProviderTopic } from '../../types/persistence.ts'
import type { PersistenceMsg, PResult } from '../../types/persistence.ts'
import type { FetchFileState, FetchFileMsg } from './types.ts'

export const fetchFileTool = defineTool('fetch_file', 'Download a file from a URL to the central persistence store and return the store key. Works with PDFs, images (jpeg, png, gif, webp, …), audio, and any other binary or text file. Use the returned key with other tools such as extract_pdf_text or analyze_image.', {
  type: 'object',
  properties: {
    url: { type: 'string', description: 'The URL of the file to download' },
  },
  required: ['url'],
})


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

const downloadAndStreamToPersist = async (
  args: FetchFileArgs,
  persistenceRef: ActorRef<PersistenceMsg>
): Promise<{ key: string; contentType: string; bytes: number }> => {
  const res = await fetch(args.url)
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${await res.text()}`)
  }
  if (!res.body) {
    throw new Error('Response body is empty')
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

  const key = `inbound/${baseName}`

  const uploadRes = await ask<PersistenceMsg, PResult>(persistenceRef, (replyTo) => ({
    type: 'obj.putStream',
    bucket: 'media',
    key,
    stream: res.body!,
    meta: { 'content-type': contentType },
    replyTo,
  }))

  if (!uploadRes.ok) {
    throw new Error(`Persistence upload failed: ${uploadRes.error}`)
  }

  const contentLength = Number(res.headers.get('content-length') ?? '0')
  return { key, contentType, bytes: contentLength }
}

// ─── Actor definition ───

export const FetchFile = (): ActorDef<FetchFileMsg, FetchFileState> => ({
  initialState: () => ({ persistenceRef: null }),
  lifecycle: onLifecycle({
    start: (state, ctx) => {
      ctx.subscribe(PersistenceProviderTopic, (event) => ({ type: '_persistenceRef' as const, ref: event.ref }))
      return { state }
    },
  }),
  handler: onMessage<FetchFileMsg, FetchFileState>({
    _persistenceRef: (state, msg) => {
      return { state: { ...state, persistenceRef: msg.ref } }
    },

    invoke: (state, message, ctx) => {
      const { arguments: rawArgs, replyTo } = message
      let args: FetchFileArgs = { url: '' }
      try { args = JSON.parse(rawArgs) as FetchFileArgs } catch { args = { url: rawArgs } }

      if (!state.persistenceRef) {
        replyTo.send({ type: 'toolError', error: 'Persistence provider not ready.' })
        return { state }
      }

      const parent = ctx.trace.fromHeaders()
      const span: SpanHandle | null = parent
        ? ctx.trace.child(parent.traceId, parent.spanId, 'fetch-file', { url: args.url })
        : null

      ctx.pipeToSelf(
        downloadAndStreamToPersist(args, state.persistenceRef),
        ({ key, contentType, bytes }) => ({ type: '_done' as const, url: args.url, key, contentType, bytes, replyTo, span }),
        (error) => ({ type: '_err' as const, url: args.url, error: String(error), replyTo, span }),
      )
      return { state }
    },

    _done: (state, message) => {
      const { key, contentType, bytes, replyTo, span } = message
      span?.done({ bytes, key })
      replyTo.send({ type: 'toolResult', result: { text: `Downloaded and stored to persistence key: ${key} (${contentType}, ${bytes} bytes)` } })
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

