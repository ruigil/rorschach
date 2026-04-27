import type { ActorContext, ActorRef, PluginDef } from '../../system/types.ts'
import { onLifecycle, onMessage } from '../../system/match.ts'
import { RouteRegistrationTopic } from '../../types/routes.ts'
import { IdentityProviderTopic } from '../../types/identity.ts'
import type { IdentityProviderMsg } from '../../types/identity.ts'
import type { ToolCollection, ToolInvokeMsg, ToolSchema } from '../../types/tools.ts'
import { ToolRegistrationTopic } from '../../types/tools.ts'

import type { GoogleApisConfig, GoogleAgentMsg, GooglePluginMsg, SharedRefs } from './types.ts'
import { createTokenStoreActor, initialTokenStoreState } from './token-store.ts'
import { createOAuthStateActor, initialOAuthStateActorState } from './oauth-state.ts'
import { buildGoogleOAuthRoutes } from './routes.ts'
import { createGoogleAgentActor, createInitialGoogleAgentState } from './google-agent.ts'

import {
  createGmailActor,
  GMAIL_LIST_MESSAGES_TOOL_NAME, GMAIL_LIST_MESSAGES_SCHEMA,
  GMAIL_GET_MESSAGE_TOOL_NAME,   GMAIL_GET_MESSAGE_SCHEMA,
  GMAIL_SEND_MESSAGE_TOOL_NAME,  GMAIL_SEND_MESSAGE_SCHEMA,
  GMAIL_SEARCH_TOOL_NAME,        GMAIL_SEARCH_SCHEMA,
} from './tools/gmail.ts'
import {
  createCalendarActor,
  CALENDAR_LIST_EVENTS_TOOL_NAME,  CALENDAR_LIST_EVENTS_SCHEMA,
  CALENDAR_CREATE_EVENT_TOOL_NAME, CALENDAR_CREATE_EVENT_SCHEMA,
  CALENDAR_UPDATE_EVENT_TOOL_NAME, CALENDAR_UPDATE_EVENT_SCHEMA,
  CALENDAR_DELETE_EVENT_TOOL_NAME, CALENDAR_DELETE_EVENT_SCHEMA,
} from './tools/calendar.ts'
import {
  createDriveActor,
  DRIVE_LIST_FILES_TOOL_NAME,    DRIVE_LIST_FILES_SCHEMA,
  DRIVE_SEARCH_FILES_TOOL_NAME,  DRIVE_SEARCH_FILES_SCHEMA,
  DRIVE_GET_FILE_TOOL_NAME,      DRIVE_GET_FILE_SCHEMA,
  DRIVE_DOWNLOAD_FILE_TOOL_NAME, DRIVE_DOWNLOAD_FILE_SCHEMA,
  DRIVE_UPLOAD_FILE_TOOL_NAME,   DRIVE_UPLOAD_FILE_SCHEMA,
} from './tools/drive.ts'

// ─── Public tool schema ───

export const GOOGLE_TOOL_NAME = 'google'

export const GOOGLE_SCHEMA: ToolSchema = {
  type: 'function',
  function: {
    name: GOOGLE_TOOL_NAME,
    description: `Interact with the user's Google Workspace (Gmail, Calendar, Drive) via a natural language request. A sub-agent handles the request and returns a summary.

This tool is for the user only — only call it when explicitly asked by the user.

**Gmail**:
- "List my last 10 emails"
- "Search emails from alice about the Q1 report"
- "Send an email to bob@example.com: subject 'Meeting notes', body '...'"
- "Show me the full content of email id 18abc..."

**Calendar**:
- "What's on my calendar this week?"
- "Create an event: Team standup, Tuesday 2025-05-06 10:00-10:30"
- "Update event id xyz: change start to 11:00"
- "Delete event id xyz"

**Drive**:
- "List my recent Drive files"
- "Search Drive for files named 'budget'"
- "Download file id abc... to local storage"
- "Upload a text file named 'notes.txt' with content '...'"
- "Upload the local file at /absolute/path/to/file.pdf to Drive"

When uploading a local file, always include its full absolute path in the request (e.g. a path returned by fetch_file or drive_download_file). Never pass just a filename — the sub-agent needs the absolute path to read the file.`,
    parameters: {
      type: 'object',
      properties: {
        request: {
          type: 'string',
          description: 'A natural language instruction describing what to do in Gmail, Calendar, or Drive.',
        },
      },
      required: ['request'],
    },
  },
}

// ─── Plugin state ───

type PluginState = {
  initialized:    boolean
  gen:            number
  model:          string
  maxToolLoops:   number
  gmailRef:       ActorRef<ToolInvokeMsg> | null
  calendarRef:    ActorRef<ToolInvokeMsg> | null
  driveRef:       ActorRef<ToolInvokeMsg> | null
  googleAgentRef: ActorRef<GoogleAgentMsg> | null
}

// ─── Helpers ───

type SpawnResult = Pick<PluginState, 'gmailRef' | 'calendarRef' | 'driveRef' | 'googleAgentRef'>

const spawnChildren = (
  gen:          number,
  model:        string,
  maxToolLoops: number,
  refs:         SharedRefs,
  ctx:          ActorContext<GooglePluginMsg>,
): SpawnResult => {
  const tokenStoreRef = refs.tokenStoreRef!
  const { clientId, clientSecret } = refs

  const gmailRef    = ctx.spawn(`googleapis-gmail-${gen}`,    createGmailActor(tokenStoreRef, clientId, clientSecret),    null) as ActorRef<ToolInvokeMsg>
  const calendarRef = ctx.spawn(`googleapis-calendar-${gen}`, createCalendarActor(tokenStoreRef, clientId, clientSecret), null) as ActorRef<ToolInvokeMsg>
  const driveRef    = ctx.spawn(`googleapis-drive-${gen}`,    createDriveActor(tokenStoreRef, clientId, clientSecret),    null) as ActorRef<ToolInvokeMsg>

  const tools: ToolCollection = {
    [GMAIL_LIST_MESSAGES_TOOL_NAME]:   { schema: GMAIL_LIST_MESSAGES_SCHEMA,   ref: gmailRef },
    [GMAIL_GET_MESSAGE_TOOL_NAME]:     { schema: GMAIL_GET_MESSAGE_SCHEMA,     ref: gmailRef },
    [GMAIL_SEND_MESSAGE_TOOL_NAME]:    { schema: GMAIL_SEND_MESSAGE_SCHEMA,    ref: gmailRef },
    [GMAIL_SEARCH_TOOL_NAME]:          { schema: GMAIL_SEARCH_SCHEMA,          ref: gmailRef },
    [CALENDAR_LIST_EVENTS_TOOL_NAME]:  { schema: CALENDAR_LIST_EVENTS_SCHEMA,  ref: calendarRef },
    [CALENDAR_CREATE_EVENT_TOOL_NAME]: { schema: CALENDAR_CREATE_EVENT_SCHEMA, ref: calendarRef },
    [CALENDAR_UPDATE_EVENT_TOOL_NAME]: { schema: CALENDAR_UPDATE_EVENT_SCHEMA, ref: calendarRef },
    [CALENDAR_DELETE_EVENT_TOOL_NAME]: { schema: CALENDAR_DELETE_EVENT_SCHEMA, ref: calendarRef },
    [DRIVE_LIST_FILES_TOOL_NAME]:      { schema: DRIVE_LIST_FILES_SCHEMA,      ref: driveRef },
    [DRIVE_SEARCH_FILES_TOOL_NAME]:    { schema: DRIVE_SEARCH_FILES_SCHEMA,    ref: driveRef },
    [DRIVE_GET_FILE_TOOL_NAME]:        { schema: DRIVE_GET_FILE_SCHEMA,        ref: driveRef },
    [DRIVE_DOWNLOAD_FILE_TOOL_NAME]:   { schema: DRIVE_DOWNLOAD_FILE_SCHEMA,   ref: driveRef },
    [DRIVE_UPLOAD_FILE_TOOL_NAME]:     { schema: DRIVE_UPLOAD_FILE_SCHEMA,     ref: driveRef },
  }

  const agentOpts     = { model, maxToolLoops, tools }
  const googleAgentRef = ctx.spawn(
    `googleapis-agent-${gen}`,
    createGoogleAgentActor(agentOpts),
    createInitialGoogleAgentState(agentOpts),
  ) as ActorRef<GoogleAgentMsg>

  ctx.publishRetained(ToolRegistrationTopic, GOOGLE_TOOL_NAME, {
    name:   GOOGLE_TOOL_NAME,
    schema: GOOGLE_SCHEMA,
    ref:    googleAgentRef as unknown as ActorRef<ToolInvokeMsg>,
  })

  return { gmailRef, calendarRef, driveRef, googleAgentRef }
}

const stopChildren = (state: PluginState, ctx: ActorContext<GooglePluginMsg>): void => {
  if (state.gmailRef)       ctx.stop(state.gmailRef)
  if (state.calendarRef)    ctx.stop(state.calendarRef)
  if (state.driveRef)       ctx.stop(state.driveRef)
  if (state.googleAgentRef) ctx.stop(state.googleAgentRef)
  ctx.deleteRetained(ToolRegistrationTopic, GOOGLE_TOOL_NAME, { name: GOOGLE_TOOL_NAME, ref: null })
}

// ─── Plugin definition ───

const googleApisPlugin: PluginDef<GooglePluginMsg, PluginState, GoogleApisConfig> = (() => {
  const refs: SharedRefs = {
    identityProviderRef: null,
    tokenStoreRef:       null,
    oauthStateRef:       null,
    clientId:            '',
    clientSecret:        '',
    baseUrl:             '',
  }

  const registerRoutes = (ctx: ActorContext<GooglePluginMsg>): void => {
    for (const reg of buildGoogleOAuthRoutes(refs)) {
      ctx.publishRetained(RouteRegistrationTopic, reg.id, reg)
    }
  }

  const deregisterRoutes = (ctx: ActorContext<GooglePluginMsg>): void => {
    for (const reg of buildGoogleOAuthRoutes(refs)) {
      ctx.deleteRetained(RouteRegistrationTopic, reg.id, { id: reg.id, method: reg.method, path: reg.path, handler: null })
    }
  }

  return {
    id:          'googleapis',
    version:     '1.0.0',
    description: 'Google Workspace integration: Gmail, Calendar, and Drive via a single "google" tool.',

    configDescriptor: {
      defaults: {
        clientId:     '',
        clientSecret: '',
        baseUrl:      '',
        agentModel:   '',
        maxToolLoops: 10,
      },
      onConfigChange: (config) => ({ type: 'config' as const, slice: config }),
    },

    initialState: {
      initialized:    false,
      gen:            0,
      model:          '',
      maxToolLoops:   10,
      gmailRef:       null,
      calendarRef:    null,
      driveRef:       null,
      googleAgentRef: null,
    },

    maskState: (state: PluginState) => {
      const { ...safe } = state
      return safe
    },

    lifecycle: onLifecycle({
      start: (state, ctx) => {
        const config       = ctx.initialConfig() as GoogleApisConfig | undefined
        const clientId     = config?.clientId     ?? ''
        const clientSecret = config?.clientSecret ?? ''
        const baseUrl      = (config?.baseUrl     ?? '').replace(/\/$/, '')
        const model        = config?.agentModel   ?? 'google/gemini-2.5-flash'
        const maxToolLoops = config?.maxToolLoops ?? 10

        refs.clientId     = clientId
        refs.clientSecret = clientSecret
        refs.baseUrl      = baseUrl

        const tokenStoreRef = ctx.spawn('googleapis-token-store', createTokenStoreActor('workspace/googleapis/tokens.json'), initialTokenStoreState())
        const oauthStateRef = ctx.spawn('googleapis-oauth-state', createOAuthStateActor(), initialOAuthStateActorState())

        refs.tokenStoreRef = tokenStoreRef
        refs.oauthStateRef = oauthStateRef

        ctx.subscribe(IdentityProviderTopic, (e) => ({ type: '_identityProvider' as const, ref: e.ref }))
        registerRoutes(ctx)

        const children = clientId && clientSecret
          ? spawnChildren(0, model, maxToolLoops, refs, ctx)
          : { gmailRef: null, calendarRef: null, driveRef: null, googleAgentRef: null }

        ctx.log.info('googleapis plugin activated', { configured: !!(clientId && clientSecret) })
        return { state: { ...state, initialized: true, gen: 0, model, maxToolLoops, ...children } }
      },

      stopped: (state, ctx) => {
        deregisterRoutes(ctx)
        stopChildren(state, ctx)
        refs.identityProviderRef = null
        ctx.log.info('googleapis plugin deactivated')
        return { state }
      },
    }),

    handler: onMessage<GooglePluginMsg, PluginState>({
      _identityProvider: (state, msg) => {
        refs.identityProviderRef = msg.ref
        return { state }
      },

      config: (state, msg, ctx) => {
        stopChildren(state, ctx)

        const cfg          = msg.slice
        const clientId     = cfg?.clientId     ?? ''
        const clientSecret = cfg?.clientSecret ?? ''
        const baseUrl      = (cfg?.baseUrl     ?? '').replace(/\/$/, '')
        const model        = cfg?.agentModel   ?? 'google/gemini-2.5-flash'
        const maxToolLoops = cfg?.maxToolLoops ?? 10
        const gen          = state.gen + 1

        refs.clientId     = clientId
        refs.clientSecret = clientSecret
        refs.baseUrl      = baseUrl

        registerRoutes(ctx)

        const children = clientId && clientSecret
          ? spawnChildren(gen, model, maxToolLoops, refs, ctx)
          : { gmailRef: null, calendarRef: null, driveRef: null, googleAgentRef: null }

        return { state: { ...state, gen, model, maxToolLoops, ...children } }
      },
    }),
  }
})()

export default googleApisPlugin
