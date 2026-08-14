import { google } from 'googleapis'
import type { ActorDef, ActorRef } from '../../../system/index.ts'
import { onMessage } from '../../../system/index.ts'
import { ask } from '../../../system/index.ts'
import { defineTool } from '../../../system/index.ts'
import type { SCRInvokeMsg, SCRReply } from '../../../types/scr.ts'
import type { GoogleToken, TokenStoreMsg } from '../types.ts'

// ─── Tool names & schemas ───

export const calendarListEventsTool = defineTool('googleapis_calendar_event_list', 'List upcoming events from Google Calendar.', {
  type: 'object',
  properties: {
    maxResults:  { type: 'number', description: 'Maximum number of events to return (default 10).' },
    timeMin:     { type: 'string', description: 'Start of time range in RFC3339 format (default: now).' },
    timeMax:     { type: 'string', description: 'End of time range in RFC3339 format (optional).' },
    calendarId:  { type: 'string', description: 'Calendar to query (default: "primary").' },
  },
})

export const calendarCreateEventTool = defineTool('googleapis_calendar_event_create', 'Create a new event in Google Calendar.', {
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
})

export const calendarUpdateEventTool = defineTool('googleapis_calendar_event_update', 'Update an existing Google Calendar event.', {
  type: 'object',
  properties: {
    eventId:     { type: 'string', description: 'Event id from googleapis_calendar_event_list.' },
    summary:     { type: 'string', description: 'New event title (optional).' },
    start:       { type: 'string', description: 'New start time as a naive local datetime without offset (e.g. "2025-04-30T14:00:00"), optional.' },
    end:         { type: 'string', description: 'New end time as a naive local datetime without offset, optional.' },
    description: { type: 'string', description: 'New description (optional).' },
    location:    { type: 'string', description: 'New location (optional).' },
    calendarId:  { type: 'string', description: 'Calendar the event belongs to (default: "primary").' },
  },
  required: ['eventId'],
})

export const calendarDeleteEventTool = defineTool('googleapis_calendar_event_delete', 'Delete an event from Google Calendar.', {
  type: 'object',
  properties: {
    eventId:    { type: 'string', description: 'Event id from googleapis_calendar_event_list.' },
    calendarId: { type: 'string', description: 'Calendar the event belongs to (default: "primary").' },
  },
  required: ['eventId'],
})

// ─── Internal message type ───

type CalendarMsg =
  | SCRInvokeMsg
  | { type: '_done';  replyTo: ActorRef<SCRReply>; result: string }
  | { type: '_error'; replyTo: ActorRef<SCRReply>; error: string }

// ─── Actor ───

export const Calendar = (
  tokenStoreRef: ActorRef<TokenStoreMsg>,
  clientId:      string,
  clientSecret:  string,
): ActorDef<CalendarMsg, null> => {
  let cachedTimezone: string | null = null

  return ({
  initialState: null,
  handler: onMessage<CalendarMsg, null>({
    invoke: (state, msg, ctx) => {
      const executeCalendarTool = async () => {
        const token = await ask<TokenStoreMsg, GoogleToken | null>(tokenStoreRef, r => ({ type: 'getToken' as const, replyTo: r }), undefined, ctx.request)
        if (!token) throw new Error('Not authenticated. Connect your Google account via Config > googleapis.')

        const auth = new google.auth.OAuth2(clientId, clientSecret)
        auth.setCredentials(token)
        if (token.expiry_date - Date.now() < 5 * 60 * 1000) {
          const { credentials } = await auth.refreshAccessToken()
          ctx.send(tokenStoreRef, { type: 'setToken' as const, token: credentials as GoogleToken })
          auth.setCredentials(credentials)
        }

        const calendar = google.calendar({ version: 'v3', auth })
        const args     = (typeof msg.input === 'string' ? JSON.parse(msg.input) : (msg.input ?? {})) as Record<string, any>
        const calId    = args.calendarId ?? 'primary'

        if (cachedTimezone === null) {
          try {
            cachedTimezone = (await calendar.settings.get({ setting: 'timezone' })).data.value ?? 'UTC'
          } catch {
            cachedTimezone = 'UTC'
          }
        }
        const tz = cachedTimezone

        const isList = msg.urn.endsWith('event_list') || msg.urn.endsWith('calendarListEvents') || msg.urn.endsWith(calendarListEventsTool.name)
        const isCreate = msg.urn.endsWith('event_create') || msg.urn.endsWith('calendarCreateEvent') || msg.urn.endsWith(calendarCreateEventTool.name)
        const isUpdate = msg.urn.endsWith('event_update') || msg.urn.endsWith('calendarUpdateEvent') || msg.urn.endsWith(calendarUpdateEventTool.name)
        const isDelete = msg.urn.endsWith('event_delete') || msg.urn.endsWith('calendarDeleteEvent') || msg.urn.endsWith(calendarDeleteEventTool.name)

        if (isList) {
          const res = await calendar.events.list({
            calendarId: calId,
            timeMin: args.timeMin ?? new Date().toISOString(),
            timeMax: args.timeMax,
            maxResults: args.maxResults ?? 10,
            singleEvents: true,
            orderBy: 'startTime',
          })
          return JSON.stringify(res.data.items)
        }

        if (isCreate) {
          if (!cachedTimezone) {
            const settings = await calendar.calendarList.get({ calendarId: calId })
            cachedTimezone = settings.data.timeZone ?? 'UTC'
          }
          const eventTz = cachedTimezone
          const event = {
            summary: args.summary,
            description: args.description,
            location: args.location,
            start: { dateTime: args.start, timeZone: eventTz },
            end:   { dateTime: args.end,   timeZone: eventTz },
          }
          const res = await calendar.events.insert({ calendarId: calId, requestBody: event })
          return `Created event ${res.data.id}`
        }

        if (isUpdate) {
          if (!cachedTimezone) {
            const settings = await calendar.calendarList.get({ calendarId: calId })
            cachedTimezone = settings.data.timeZone ?? 'UTC'
          }
          const eventTz = cachedTimezone
          const patch: any = {}
          if (args.summary !== undefined) patch.summary = args.summary
          if (args.description !== undefined) patch.description = args.description
          if (args.location !== undefined) patch.location = args.location
          if (args.start !== undefined) patch.start = { dateTime: args.start, timeZone: eventTz }
          if (args.end !== undefined) patch.end = { dateTime: args.end, timeZone: eventTz }
          await calendar.events.patch({ calendarId: calId, eventId: args.eventId, requestBody: patch })
          return `Updated event ${args.eventId}`
        }

        if (isDelete) {
          await calendar.events.delete({ calendarId: calId, eventId: args.eventId })
          return `Deleted event ${args.eventId}`
        }

        throw new Error(`Unknown Calendar tool: ${msg.urn}`)
      }

      ctx.pipeToSelf(
        executeCalendarTool(),
        (result): CalendarMsg => ({ type: '_done', replyTo: msg.replyTo, result }),
        (err):    CalendarMsg => ({ type: '_error', replyTo: msg.replyTo, error: String(err) }),
      )
      return { state }
    },

    _done:  (state, msg) => { msg.replyTo.send({ type: 'result', output: { text: msg.result } }); return { state } },
    _error: (state, msg) => { msg.replyTo.send({ type: 'error',  error:  msg.error  }); return { state } },
  }),
})
}
