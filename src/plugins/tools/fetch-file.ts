import { join } from 'node:path'
import { mkdir } from 'node:fs/promises'
import type { ActorDef, ActorRef, SpanHandle } from '../../system/types.ts'
import { onMessage } from '../../system/match.ts'
import type { ToolInvokeMsg, ToolReply, ToolSchema } from '../../types/tools.ts'

const INBOUND_DIR = join(import.meta.dir, '../../public/inbound')

// ─── Tool schema ───

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

// ─── Internal message protocol ───

export type FetchFileMsg =
  | ToolInvokeMsg
  | { type: '_done'; url: string; filePath: string; contentType: string; bytes: number; replyTo: ActorRef<ToolReply>; span: SpanHandle | null }
  | { type: '_err'; url: string; error: string; replyTo: ActorRef<ToolReply>; span: SpanHandle | null }

// ─── Download logic ───

type FetchFileArgs = { url: string }

// Derive a file extension from Content-Type or the URL path as a fallback.
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
  // Fall back to URL path extension
  const urlExt = url.split('?')[0]?.split('#')[0]?.split('.').pop()
  return urlExt && urlExt.length <= 5 ? urlExt : 'bin'
}

const downloadFile = async (args: FetchFileArgs): Promise<{ filePath: string; contentType: string; bytes: number }> => {
  const res = await fetch(args.url)
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${await res.text()}`)
  }

  const contentType = res.headers.get('content-type') ?? ''
  const ext = guessExtension(contentType, args.url)
  const filePath = join(INBOUND_DIR, `rorschach-${crypto.randomUUID()}.${ext}`)

  const buffer = await res.arrayBuffer()
  await mkdir(INBOUND_DIR, { recursive: true })
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
