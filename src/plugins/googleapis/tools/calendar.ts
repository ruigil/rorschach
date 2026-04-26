import { google } from 'googleapis'
import type { ActorDef, ActorRef } from '../../../system/types.ts'
import { onMessage } from '../../../system/match.ts'
import { ask } from '../../../system/ask.ts'
import type { ToolInvokeMsg, ToolReply, ToolSchema } from '../../../types/tools.ts'
import type { GoogleToken, TokenStoreMsg } from '../types.ts'

// ─── Tool names & schemas ───

export const CALENDAR_LIST_EVENTS_TOOL_NAME   = 'calendar_list_events'
export const CALENDAR_CREATE_EVENT_TOOL_NAME  = 'calendar_create_event'
export const CALENDAR_UPDATE_EVENT_TOOL_NAME  = 'calendar_update_event'
export const CALENDAR_DELETE_EVENT_TOOL_NAME  = 'calendar_delete_event'

export const CALENDAR_LIST_EVENTS_SCHEMA: ToolSchema = {
  type: 'function',
  function: {
    name: CALENDAR_LIST_EVENTS_TOOL_NAME,
    description: 'List upcoming events from Google Calendar.',
    parameters: {
      type: 'object',
      properties: {
        maxResults:  { type: 'number', description: 'Maximum number of events to return (default 10).' },
        timeMin:     { type: 'string', description: 'Start of time range in RFC3339 format (default: now).' },
        timeMax:     { type: 'string', description: 'End of time range in RFC3339 format (optional).' },
        calendarId:  { type: 'string', description: 'Calendar to query (default: "primary").' },
      },
    },
  },
}

export const CALENDAR_CREATE_EVENT_SCHEMA: ToolSchema = {
  type: 'function',
  function: {
    name: CALENDAR_CREATE_EVENT_TOOL_NAME,
    description: 'Create a new event in Google Calendar.',
    parameters: {
      type: 'object',
      properties: {
        summary:     { type: 'string', description: 'Event title.' },
        start:       { type: 'string', description: 'Start time as a naive local datetime without offset (e.g. "2025-04-30T14:00:00"). The user\'s Google Calendar timezone is applied automatically.' },
        end:         { type: 'string', description: 'End time as a naive local datetime without offset (e.g. "2025-04-30T15:00:00").' },
        description: { type: 'string', description: 'Event description (optional).' },
        location:    { type: 'string', description: 'Event location (optional).' },
        calendarId:  { type: 'string', description: 'Calendar to create the event in (default: "primary").' },
      },
      required: ['summary', 'start', 'end'],
    },
  },
}

export const CALENDAR_UPDATE_EVENT_SCHEMA: ToolSchema = {
  type: 'function',
  function: {
    name: CALENDAR_UPDATE_EVENT_TOOL_NAME,
    description: 'Update an existing Google Calendar event.',
    parameters: {
      type: 'object',
      properties: {
        eventId:     { type: 'string', description: 'Event id from calendar_list_events.' },
        summary:     { type: 'string', description: 'New event title (optional).' },
        start:       { type: 'string', description: 'New start time as a naive local datetime without offset (e.g. "2025-04-30T14:00:00"), optional.' },
        end:         { type: 'string', description: 'New end time as a naive local datetime without offset, optional.' },
        description: { type: 'string', description: 'New description (optional).' },
        location:    { type: 'string', description: 'New location (optional).' },
        calendarId:  { type: 'string', description: 'Calendar the event belongs to (default: "primary").' },
      },
      required: ['eventId'],
    },
  },
}

export const CALENDAR_DELETE_EVENT_SCHEMA: ToolSchema = {
  type: 'function',
  function: {
    name: CALENDAR_DELETE_EVENT_TOOL_NAME,
    description: 'Delete an event from Google Calendar.',
    parameters: {
      type: 'object',
      properties: {
        eventId:    { type: 'string', description: 'Event id from calendar_list_events.' },
        calendarId: { type: 'string', description: 'Calendar the event belongs to (default: "primary").' },
      },
      required: ['eventId'],
    },
  },
}

// ─── Internal message type ───

type CalendarMsg =
  | ToolInvokeMsg
  | { type: '_done';  replyTo: ActorRef<ToolReply>; result: string }
  | { type: '_error'; replyTo: ActorRef<ToolReply>; error: string }

// ─── Actor ───

export const createCalendarActor = (
  tokenStoreRef: ActorRef<TokenStoreMsg>,
  clientId:      string,
  clientSecret:  string,
): ActorDef<CalendarMsg, null> => {
  let cachedTimezone: string | null = null

  return ({
  handler: onMessage<CalendarMsg, null>({
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

          const calendar = google.calendar({ version: 'v3', auth })
          const args     = JSON.parse(msg.arguments) as Record<string, any>
          const calId    = args.calendarId ?? 'primary'

          if (cachedTimezone === null) {
            try {
              cachedTimezone = (await calendar.settings.get({ setting: 'timezone' })).data.value ?? 'UTC'
            } catch {
              cachedTimezone = 'UTC'
            }
          }
          const tz = cachedTimezone

          if (msg.toolName === CALENDAR_LIST_EVENTS_TOOL_NAME) {
            const res = await calendar.events.list({
              calendarId: calId,
              maxResults: args.maxResults ?? 10,
              timeMin:    args.timeMin ?? new Date().toISOString(),
              timeMax:    args.timeMax,
              singleEvents: true,
              orderBy:    'startTime',
            })
            return JSON.stringify((res.data.items ?? []).map(e => ({
              id:       e.id,
              summary:  e.summary,
              start:    e.start?.dateTime ?? e.start?.date,
              end:      e.end?.dateTime   ?? e.end?.date,
              timeZone: e.start?.timeZone ?? null,
              location: e.location,
              description: e.description,
            })))
          }

          if (msg.toolName === CALENDAR_CREATE_EVENT_TOOL_NAME) {
            const res = await calendar.events.insert({
              calendarId:  calId,
              requestBody: {
                summary:     args.summary,
                description: args.description,
                location:    args.location,
                start: { dateTime: args.start, timeZone: tz },
                end:   { dateTime: args.end,   timeZone: tz },
              },
            })
            return `Event created: ${res.data.summary} (id: ${res.data.id})`
          }

          if (msg.toolName === CALENDAR_UPDATE_EVENT_TOOL_NAME) {
            const existing = await calendar.events.get({ calendarId: calId, eventId: args.eventId })
            const body     = existing.data
            if (args.summary)     body.summary     = args.summary
            if (args.description) body.description = args.description
            if (args.location)    body.location    = args.location
            if (args.start)       body.start       = { dateTime: args.start, timeZone: tz }
            if (args.end)         body.end         = { dateTime: args.end,   timeZone: tz }
            const res = await calendar.events.update({ calendarId: calId, eventId: args.eventId, requestBody: body })
            return `Event updated: ${res.data.summary}`
          }

          if (msg.toolName === CALENDAR_DELETE_EVENT_TOOL_NAME) {
            await calendar.events.delete({ calendarId: calId, eventId: args.eventId })
            return `Event ${args.eventId} deleted.`
          }

          throw new Error(`Unknown Calendar tool: ${msg.toolName}`)
        })(),
        (result): CalendarMsg => ({ type: '_done', replyTo: msg.replyTo, result }),
        (err):    CalendarMsg => ({ type: '_error', replyTo: msg.replyTo, error: String(err) }),
      )
      return { state }
    },

    _done:  (state, msg) => { msg.replyTo.send({ type: 'toolResult', result: msg.result }); return { state } },
    _error: (state, msg) => { msg.replyTo.send({ type: 'toolError',  error:  msg.error  }); return { state } },
  }),
})
}
