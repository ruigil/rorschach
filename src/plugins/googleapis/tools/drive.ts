import { google } from 'googleapis'
import { Readable } from 'node:stream'
import type { ActorDef, ActorRef } from '../../../system/index.ts'
import { onMessage, onLifecycle } from '../../../system/index.ts'
import { ask } from '../../../system/index.ts'
import { defineTool } from '../../../system/index.ts'
import type { ToolInvokeMsg, ToolReply } from '../../../types/tools.ts'
import type { GoogleToken, TokenStoreMsg } from '../types.ts'
import { PersistenceProviderTopic } from '../../../types/persistence.ts'
import type { PersistenceMsg, PResult } from '../../../types/persistence.ts'

// ─── Tool names & schemas ───

export const driveListFilesTool = defineTool('drive_list_files', 'List files in Google Drive, optionally filtered to a specific folder.', {
  type: 'object',
  properties: {
    maxResults: { type: 'number', description: 'Maximum number of files to return (default 20).' },
    folderId:   { type: 'string', description: 'Return only files in this folder id (optional).' },
  },
})

export const driveSearchFilesTool = defineTool('drive_search_files', "Search Google Drive using Drive query syntax (e.g. 'name contains budget' or 'mimeType=application/pdf').", {
  type: 'object',
  properties: {
    query:      { type: 'string', description: 'Drive search query string.' },
    maxResults: { type: 'number', description: 'Maximum results to return (default 20).' },
  },
  required: ['query'],
})

export const driveGetFileTool = defineTool('drive_get_file', 'Get metadata for a Google Drive file by its id.', {
  type: 'object',
  properties: {
    fileId: { type: 'string', description: 'File id from drive_list_files or drive_search_files.' },
  },
  required: ['fileId'],
})

export const driveDownloadFileTool = defineTool('drive_download_file', 'Download a Google Drive file to central persistence store (under inbound/) and return its key. Google Docs → text (default) or pdf. Sheets → csv (default) or pdf. Slides → always pdf. Binary files (PDF, images, etc.) are downloaded as-is. Use the returned key with extract_pdf_text or analyze_image.', {
  type: 'object',
  properties: {
    fileId: { type: 'string', description: 'File id from drive_list_files or drive_search_files.' },
    exportFormat: {
      type: 'string',
      enum: ['text', 'pdf', 'csv'],
      description: 'For Google Workspace files only: "text" (default for Docs), "pdf", "csv" (Sheets only).',
    },
  },
  required: ['fileId'],
})

export const driveUploadFileTool = defineTool('drive_upload_file', 'Upload a file to Google Drive. Provide either inline text content or the key of a file in persistence (from inbound/ or generated/). MIME type is inferred from file extension.', {
  type: 'object',
  properties: {
    name:     { type: 'string', description: 'Drive file name. When filePath is given, defaults to the filename.' },
    content:  { type: 'string', description: 'Inline text content. Use this OR filePath, not both.' },
    filePath: { type: 'string', description: 'Key of a file in persistence to upload. Use this OR content.' },
    folderId: { type: 'string', description: 'Parent folder id (optional; defaults to Drive root).' },
  },
})

// ─── Internal message type ───

type DriveMsg =
  | ToolInvokeMsg
  | { type: '_done';  replyTo: ActorRef<ToolReply>; result: string }
  | { type: '_error'; replyTo: ActorRef<ToolReply>; error: string }
  | { type: '_persistenceRef'; ref: ActorRef<PersistenceMsg> | null }

// ─── Helpers ───

const FILE_FIELDS = 'id, name, mimeType, size, modifiedTime, webViewLink'

const MIME_BY_EXT: Record<string, string> = {
  txt: 'text/plain', md: 'text/markdown', html: 'text/html', csv: 'text/csv',
  json: 'application/json', pdf: 'application/pdf',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
  mp3: 'audio/mpeg', wav: 'audio/wav', mp4: 'video/mp4', zip: 'application/zip',
}

const mimeFromPath = (p: string): string =>
  MIME_BY_EXT[p.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream'

const sanitizeBasename = (name: string): string =>
  name.replace(/[/\\:*?"<>|]/g, '_').replace(/\r?\n|\t/g, '_')
      .replace(/^\.+|\.+$/g, '').replace(/\.{2,}/g, '.')

const resolveUniqueKey = async (
  persistenceRef: ActorRef<PersistenceMsg>,
  bucket: string,
  prefix: string,
  basename: string,
): Promise<string> => {
  let key = `${prefix}/${basename}`
  const checkExists = async (k: string): Promise<boolean> => {
    const res = await ask<PersistenceMsg, PResult<Record<string, string>>>(
      persistenceRef,
      (replyTo) => ({ type: 'obj.head', bucket, key: k, replyTo }),
    )
    return res.ok
  }

  if (!(await checkExists(key))) return key
  const dotIdx = basename.lastIndexOf('.')
  const hasExt = dotIdx > 0 && dotIdx < basename.length - 1
  const stem = hasExt ? basename.slice(0, dotIdx) : basename
  const ext  = hasExt ? basename.slice(dotIdx) : ''
  for (let i = 1; i < 1000; i++) {
    key = `${prefix}/${stem}-${i}${ext}`
    if (!(await checkExists(key))) return key
  }
  return `${prefix}/${stem}-${crypto.randomUUID()}${ext}`
}

const arrayBufferToStream = (buffer: ArrayBuffer): ReadableStream<Uint8Array> => {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(buffer))
      controller.close()
    }
  })
}

// ─── Actor ───

export type DriveState = {
  persistenceRef: ActorRef<PersistenceMsg> | null
}

export const Drive = (
  tokenStoreRef: ActorRef<TokenStoreMsg>,
  clientId:      string,
  clientSecret:  string,
): ActorDef<DriveMsg, DriveState> => ({
  initialState: () => ({ persistenceRef: null }),
  lifecycle: onLifecycle({
    start: (state, ctx) => {
      ctx.subscribe(PersistenceProviderTopic, (event) => ({ type: '_persistenceRef' as const, ref: event.ref }))
      return { state }
    },
  }),
  handler: onMessage<DriveMsg, DriveState>({
    _persistenceRef: (state, msg) => {
      return { state: { ...state, persistenceRef: msg.ref } }
    },

    invoke: (state, msg, ctx) => {
      ctx.pipeToSelf(
        (async () => {
          if (!state.persistenceRef) {
            throw new Error('Persistence provider not ready.')
          }

          const token = await ask<TokenStoreMsg, GoogleToken | null>(tokenStoreRef, r => ({ type: 'getToken' as const, userId: msg.userId, replyTo: r }))
          if (!token) throw new Error('Not authenticated. Connect your Google account via Config > googleapis.')

          const auth = new google.auth.OAuth2(clientId, clientSecret)
          auth.setCredentials(token)
          if (token.expiry_date - Date.now() < 5 * 60 * 1000) {
            const { credentials } = await auth.refreshAccessToken()
            tokenStoreRef.send({ type: 'setToken', userId: msg.userId, token: credentials as GoogleToken })
            auth.setCredentials(credentials)
          }

          const drive = google.drive({ version: 'v3', auth })
          const args  = JSON.parse(msg.arguments) as Record<string, any>

          if (msg.toolName === driveListFilesTool.name) {
            const res = await drive.files.list({ pageSize: args.maxResults ?? 20, q: args.folderId ? `'${args.folderId}' in parents and trashed=false` : 'trashed=false', fields: `files(${FILE_FIELDS})` })
            return JSON.stringify(res.data.files)
          }
          if (msg.toolName === driveSearchFilesTool.name) {
            const res = await drive.files.list({ pageSize: args.maxResults ?? 20, q: `${args.query} and trashed=false`, fields: `files(${FILE_FIELDS})` })
            return JSON.stringify(res.data.files)
          }
          if (msg.toolName === driveGetFileTool.name) {
            const res = await drive.files.get({ fileId: args.fileId, fields: FILE_FIELDS })
            return JSON.stringify(res.data)
          }
          if (msg.toolName === driveDownloadFileTool.name) {
            const meta = await drive.files.get({ fileId: args.fileId, fields: 'mimeType, name' })
            const mime = meta.data.mimeType ?? ''
            const originalName = meta.data.name ?? `drive-file-${args.fileId}`
            const exportFormat: string = args.exportFormat ?? 'text'

            let finalKey = ''
            let resData: ArrayBuffer

            if (mime.startsWith('application/vnd.google-apps.')) {
              let exportMime: string, fileExt: string
              if (mime === 'application/vnd.google-apps.spreadsheet') {
                exportMime = exportFormat === 'pdf' ? 'application/pdf' : 'text/csv'
                fileExt    = exportFormat === 'pdf' ? 'pdf' : 'csv'
              } else if (mime === 'application/vnd.google-apps.presentation') {
                exportMime = 'application/pdf'; fileExt = 'pdf'
              } else {
                exportMime = exportFormat === 'pdf' ? 'application/pdf' : 'text/plain'
                fileExt    = exportFormat === 'pdf' ? 'pdf' : 'txt'
              }
              const sanitized = sanitizeBasename(originalName)
              const basename  = sanitized.endsWith(`.${fileExt}`) ? sanitized : `${sanitized}.${fileExt}`
              finalKey  = await resolveUniqueKey(state.persistenceRef, 'media', 'inbound', basename)
              const res = await drive.files.export(
                { fileId: args.fileId, mimeType: exportMime },
                { responseType: 'arraybuffer' },
              )
              resData = res.data as ArrayBuffer
            } else {
              const sanitized = sanitizeBasename(originalName)
              finalKey  = await resolveUniqueKey(state.persistenceRef, 'media', 'inbound', sanitized || `drive-${args.fileId}.bin`)
              const res = await drive.files.get(
                { fileId: args.fileId, alt: 'media' } as any,
                { responseType: 'arraybuffer' },
              )
              resData = res.data as ArrayBuffer
            }

            const uploadRes = await ask<PersistenceMsg, PResult>(
              state.persistenceRef,
              (replyTo) => ({
                type: 'obj.putStream',
                bucket: 'media',
                key: finalKey,
                stream: arrayBufferToStream(resData),
                meta: { 'content-type': mimeFromPath(finalKey) },
                replyTo,
              })
            )
            if (!uploadRes.ok) {
              throw new Error(`Persistence upload failed: ${uploadRes.error}`)
            }

            return `Downloaded and stored to persistence key: ${finalKey}`
          }
          if (msg.toolName === driveUploadFileTool.name) {
            let uploadName: string, uploadMime: string, body: NodeJS.ReadableStream

            if (args.filePath) {
              const getRes = await ask<PersistenceMsg, PResult<{ stream: ReadableStream<Uint8Array>; meta: Record<string, string> }>>(
                state.persistenceRef,
                (replyTo) => ({
                  type: 'obj.getStream',
                  bucket: 'media',
                  key: args.filePath as string,
                  replyTo,
                })
              )
              if (!getRes.ok) {
                throw new Error(`File not found in persistence: ${args.filePath}`)
              }

              uploadMime = getRes.data?.meta?.['content-type'] ?? mimeFromPath(args.filePath as string)
              const pathName = (args.filePath as string).split('/').pop() ?? 'upload'
              uploadName = (args.name as string | undefined) ?? pathName
              body = Readable.fromWeb(getRes.data?.stream as any)
            } else if (args.content !== undefined) {
              if (!args.name) throw new Error('name is required when uploading inline content')
              uploadName = args.name as string
              uploadMime = 'text/plain'
              body = Readable.from([args.content as string])
            } else {
              throw new Error('Provide either content (inline text) or filePath (persistence file key)')
            }

            const res = await drive.files.create({
              requestBody: { name: uploadName, parents: args.folderId ? [args.folderId as string] : undefined },
              media: { mimeType: uploadMime, body },
              fields: 'id, name, webViewLink',
            })
            return `File uploaded: ${res.data.name} (id: ${res.data.id}) — ${res.data.webViewLink}`
          }

          throw new Error(`Unknown Drive tool: ${msg.toolName}`)
        })(),
        (result): DriveMsg => ({ type: '_done', replyTo: msg.replyTo, result }),
        (err):    DriveMsg => ({ type: '_error', replyTo: msg.replyTo, error: String(err) }),
      )
      return { state }
    },

    _done:  (state, msg) => { msg.replyTo.send({ type: 'toolResult', result: { text: msg.result } }); return { state } },
    _error: (state, msg) => { msg.replyTo.send({ type: 'toolError',  error:  msg.error  }); return { state } },
  }),
})
