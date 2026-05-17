import { google } from 'googleapis'
import type { ActorDef, ActorRef } from '../../../system/types.ts'
import { onMessage } from '../../../system/match.ts'
import { ask } from '../../../system/ask.ts'
import { defineTool } from '../../../system/tool-utils.ts'
import type { ToolInvokeMsg, ToolReply } from '../../../types/tools.ts'
import type { GoogleToken, TokenStoreMsg } from '../types.ts'

// ─── Tool names & schemas ───

export const gmailListMessagesTool = defineTool('gmail_list_messages', 'List recent Gmail messages. Returns id, subject, sender, date and snippet for each.', {
  type: 'object',
  properties: {
    maxResults: { type: 'number', description: 'Maximum number of messages to return (default 10, max 50).' },
    labelIds:   { type: 'array', items: { type: 'string' }, description: 'Only return messages with these label IDs (e.g. ["INBOX", "UNREAD"]).' },
  },
})

export const gmailGetMessageTool = defineTool('gmail_get_message', 'Get the full content of a Gmail message by its id.', {
  type: 'object',
  properties: {
    id: { type: 'string', description: 'The message id from gmail_list_messages or gmail_search.' },
  },
  required: ['id'],
})

export const gmailSendMessageTool = defineTool('gmail_send_message', 'Send an email via Gmail.', {
  type: 'object',
  properties: {
    to:      { type: 'string', description: 'Recipient email address.' },
    subject: { type: 'string', description: 'Email subject line.' },
    body:    { type: 'string', description: 'Plain-text email body.' },
    cc:      { type: 'string', description: 'CC email address (optional).' },
  },
  required: ['to', 'subject', 'body'],
})

export const gmailSearchTool = defineTool('gmail_search', 'Search Gmail messages using Gmail query syntax (e.g. "from:alice subject:report after:2024/01/01").', {
  type: 'object',
  properties: {
    query:      { type: 'string', description: 'Gmail search query.' },
    maxResults: { type: 'number', description: 'Maximum results to return (default 10, max 50).' },
  },
  required: ['query'],
})

// ─── Internal message type ───

type GmailMsg =
  | ToolInvokeMsg
  | { type: '_done';  replyTo: ActorRef<ToolReply>; result: string }
  | { type: '_error'; replyTo: ActorRef<ToolReply>; error: string }

// ─── Helpers ───

const buildRawEmail = (to: string, subject: string, body: string, cc?: string): string => {
  const lines = [
    `To: ${to}`,
    ...(cc ? [`Cc: ${cc}`] : []),
    `Subject: ${subject}`,
    'Content-Type: text/plain; charset=UTF-8',
    '',
    body,
  ]
  return Buffer.from(lines.join('\r\n')).toString('base64url')
}

const extractBody = (payload: any): string => {
  if (!payload) return ''
  if (payload.body?.data) return Buffer.from(payload.body.data, 'base64').toString()
  if (payload.parts) {
    for (const part of payload.parts) {
      if (part.mimeType === 'text/plain' && part.body?.data)
        return Buffer.from(part.body.data, 'base64').toString()
    }
    for (const part of payload.parts) {
      const nested = extractBody(part)
      if (nested) return nested
    }
  }
  return ''
}

const header = (msg: any, name: string): string =>
  msg.payload?.headers?.find((h: any) => h.name.toLowerCase() === name.toLowerCase())?.value ?? ''

// ─── Actor ───

export const Gmail = (
  tokenStoreRef: ActorRef<TokenStoreMsg>,
  clientId:      string,
  clientSecret:  string,
): ActorDef<GmailMsg, null> => ({
  initialState: null,
  handler: onMessage<GmailMsg, null>({
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

          const gmail = google.gmail({ version: 'v1', auth })
          const args  = JSON.parse(msg.arguments) as Record<string, any>

            if (msg.toolName === gmailListMessagesTool.name) {
              const res = await gmail.users.messages.list({ userId: 'me', maxResults: args.maxResults ?? 10, labelIds: args.labelIds })
              const msgs = res.data.messages ?? []
              const details = await Promise.all(msgs.slice(0, 50).map(async (m) => {
                const d = await gmail.users.messages.get({ userId: 'me', id: m.id!, format: 'metadata', metadataHeaders: ['Subject', 'From', 'Date'] })
                return { id: m.id, subject: header(d.data, 'Subject'), from: header(d.data, 'From'), date: header(d.data, 'Date'), snippet: d.data.snippet }
              }))
              return JSON.stringify(details)
            }

            if (msg.toolName === gmailGetMessageTool.name) {
              const res = await gmail.users.messages.get({ userId: 'me', id: args.id, format: 'full' })
              const body = extractBody(res.data.payload)
              const subject = header(res.data, 'Subject')
              const from = header(res.data, 'From')
              const date = header(res.data, 'Date')
              return `From: ${from}\nDate: ${date}\nSubject: ${subject}\n\n${body}`
            }

            if (msg.toolName === gmailSendMessageTool.name) {
              const raw = buildRawEmail(args.to, args.subject, args.body, args.cc)
              await gmail.users.messages.send({ userId: 'me', requestBody: { raw } })
              return `Sent email to ${args.to}`
            }

            if (msg.toolName === gmailSearchTool.name) {
            const res = await gmail.users.messages.list({ userId: 'me', q: args.query, maxResults: args.maxResults ?? 10 })
            const messages = await Promise.all(
              (res.data.messages ?? []).map(m =>
                gmail.users.messages.get({ userId: 'me', id: m.id!, format: 'metadata', metadataHeaders: ['Subject', 'From', 'Date'] })
              )
            )
            return JSON.stringify(messages.map(m => ({
              id:      m.data.id,
              subject: header(m.data, 'Subject'),
              from:    header(m.data, 'From'),
              date:    header(m.data, 'Date'),
              snippet: m.data.snippet,
            })))
          }

          throw new Error(`Unknown Gmail tool: ${msg.toolName}`)
        })(),
        (result): GmailMsg => ({ type: '_done', replyTo: msg.replyTo, result }),
        (err):    GmailMsg => ({ type: '_error', replyTo: msg.replyTo, error: String(err) }),
      )
      return { state }
    },

    _done:  (state, msg) => { msg.replyTo.send({ type: 'toolResult', result: { text: msg.result } });       return { state } },
    _error: (state, msg) => { msg.replyTo.send({ type: 'toolError',  error:  msg.error  });       return { state } },
  }),
})
