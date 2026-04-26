import { google } from 'googleapis'
import type { ActorDef, ActorRef } from '../../../system/types.ts'
import { onMessage } from '../../../system/match.ts'
import { ask } from '../../../system/ask.ts'
import type { ToolInvokeMsg, ToolReply, ToolSchema } from '../../../types/tools.ts'
import type { GoogleToken, TokenStoreMsg } from '../types.ts'

// ─── Tool names & schemas ───

export const DRIVE_LIST_FILES_TOOL_NAME     = 'drive_list_files'
export const DRIVE_SEARCH_FILES_TOOL_NAME   = 'drive_search_files'
export const DRIVE_GET_FILE_TOOL_NAME       = 'drive_get_file'
export const DRIVE_DOWNLOAD_FILE_TOOL_NAME  = 'drive_download_file'
export const DRIVE_UPLOAD_FILE_TOOL_NAME    = 'drive_upload_file'

export const DRIVE_LIST_FILES_SCHEMA: ToolSchema = {
  type: 'function',
  function: {
    name: DRIVE_LIST_FILES_TOOL_NAME,
    description: 'List files in Google Drive, optionally filtered to a specific folder.',
    parameters: {
      type: 'object',
      properties: {
        maxResults: { type: 'number', description: 'Maximum number of files to return (default 20).' },
        folderId:   { type: 'string', description: 'Return only files in this folder id (optional).' },
      },
    },
  },
}

export const DRIVE_SEARCH_FILES_SCHEMA: ToolSchema = {
  type: 'function',
  function: {
    name: DRIVE_SEARCH_FILES_TOOL_NAME,
    description: 'Search Google Drive using Drive query syntax (e.g. "name contains \'budget\'" or "mimeType=\'application/pdf\'").',
    parameters: {
      type: 'object',
      properties: {
        query:      { type: 'string', description: 'Drive search query string.' },
        maxResults: { type: 'number', description: 'Maximum results to return (default 20).' },
      },
      required: ['query'],
    },
  },
}

export const DRIVE_GET_FILE_SCHEMA: ToolSchema = {
  type: 'function',
  function: {
    name: DRIVE_GET_FILE_TOOL_NAME,
    description: 'Get metadata for a Google Drive file by its id.',
    parameters: {
      type: 'object',
      properties: {
        fileId: { type: 'string', description: 'File id from drive_list_files or drive_search_files.' },
      },
      required: ['fileId'],
    },
  },
}

export const DRIVE_DOWNLOAD_FILE_SCHEMA: ToolSchema = {
  type: 'function',
  function: {
    name: DRIVE_DOWNLOAD_FILE_TOOL_NAME,
    description: 'Download and return the text content of a Google Drive file (Google Docs exported as plain text; other text files returned as-is).',
    parameters: {
      type: 'object',
      properties: {
        fileId: { type: 'string', description: 'File id from drive_list_files or drive_search_files.' },
      },
      required: ['fileId'],
    },
  },
}

export const DRIVE_UPLOAD_FILE_SCHEMA: ToolSchema = {
  type: 'function',
  function: {
    name: DRIVE_UPLOAD_FILE_TOOL_NAME,
    description: 'Create a new plain-text file in Google Drive.',
    parameters: {
      type: 'object',
      properties: {
        name:     { type: 'string', description: 'File name (including extension).' },
        content:  { type: 'string', description: 'Text content to write.' },
        folderId: { type: 'string', description: 'Parent folder id (optional; defaults to Drive root).' },
      },
      required: ['name', 'content'],
    },
  },
}

// ─── Internal message type ───

type DriveMsg =
  | ToolInvokeMsg
  | { type: '_done';  replyTo: ActorRef<ToolReply>; result: string }
  | { type: '_error'; replyTo: ActorRef<ToolReply>; error: string }

// ─── Helpers ───

const FILE_FIELDS = 'id, name, mimeType, size, modifiedTime, webViewLink'

// ─── Actor ───

export const createDriveActor = (
  tokenStoreRef: ActorRef<TokenStoreMsg>,
  clientId:      string,
  clientSecret:  string,
): ActorDef<DriveMsg, null> => ({
  handler: onMessage<DriveMsg, null>({
    invoke: (state, msg, ctx) => {
      ctx.pipeToSelf(
        (async () => {
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

          if (msg.toolName === DRIVE_LIST_FILES_TOOL_NAME) {
            const q = args.folderId ? `'${args.folderId}' in parents and trashed=false` : 'trashed=false'
            const res = await drive.files.list({ q, pageSize: args.maxResults ?? 20, fields: `files(${FILE_FIELDS})` })
            return JSON.stringify(res.data.files ?? [])
          }

          if (msg.toolName === DRIVE_SEARCH_FILES_TOOL_NAME) {
            const res = await drive.files.list({ q: args.query, pageSize: args.maxResults ?? 20, fields: `files(${FILE_FIELDS})` })
            return JSON.stringify(res.data.files ?? [])
          }

          if (msg.toolName === DRIVE_GET_FILE_TOOL_NAME) {
            const res = await drive.files.get({ fileId: args.fileId, fields: FILE_FIELDS + ', description, parents' })
            return JSON.stringify(res.data)
          }

          if (msg.toolName === DRIVE_DOWNLOAD_FILE_TOOL_NAME) {
            const meta = await drive.files.get({ fileId: args.fileId, fields: 'mimeType, name' })
            const mime = meta.data.mimeType ?? ''

            if (mime === 'application/vnd.google-apps.document') {
              const res = await drive.files.export({ fileId: args.fileId, mimeType: 'text/plain' }, { responseType: 'text' })
              return String(res.data)
            }

            if (mime.startsWith('text/')) {
              const res = await drive.files.get({ fileId: args.fileId, alt: 'media' } as any, { responseType: 'text' })
              return String(res.data)
            }

            return `File "${meta.data.name}" (${mime}) is not a text file and cannot be downloaded as text.`
          }

          if (msg.toolName === DRIVE_UPLOAD_FILE_TOOL_NAME) {
            const { Readable } = await import('node:stream')
            const stream = Readable.from([args.content])
            const res = await drive.files.create({
              requestBody: {
                name:    args.name,
                parents: args.folderId ? [args.folderId] : undefined,
              },
              media: { mimeType: 'text/plain', body: stream },
              fields: 'id, name, webViewLink',
            })
            return `File uploaded: ${res.data.name} (id: ${res.data.id})`
          }

          throw new Error(`Unknown Drive tool: ${msg.toolName}`)
        })(),
        (result): DriveMsg => ({ type: '_done', replyTo: msg.replyTo, result }),
        (err):    DriveMsg => ({ type: '_error', replyTo: msg.replyTo, error: String(err) }),
      )
      return { state }
    },

    _done:  (state, msg) => { msg.replyTo.send({ type: 'toolResult', result: msg.result }); return { state } },
    _error: (state, msg) => { msg.replyTo.send({ type: 'toolError',  error:  msg.error  }); return { state } },
  }),
})
