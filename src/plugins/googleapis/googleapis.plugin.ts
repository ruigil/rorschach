import type { ActorContext, ActorRef, PluginDef } from '../../system/types.ts'
import { defineConfig, publishConfigSurface, deleteConfigSurface } from '../../system/plugin-config.ts'
import { onLifecycle, onMessage } from '../../system/match.ts'
import { RouteRegistrationTopic } from '../../types/routes.ts'
import { defineTool } from '../../system/tool-utils.ts'
import { ToolRegistrationTopic } from '../../types/tools.ts'
import type { ToolCollection, ToolMsg } from '../../types/tools.ts'

import type { GoogleApisConfig, GooglePluginMsg, GoogleAgentMsg, TokenStoreMsg, OAuthStateMsg } from './types.ts'
import { TokenStore } from './token-store.ts'
import { OAuthState } from './oauth-state.ts'
import { buildGoogleOAuthRoutes, googleapisSchemas } from './routes.ts'
import { GoogleAgent } from './google-agent.ts'

import {
  Gmail,
  gmailListMessagesTool, gmailGetMessageTool, gmailSendMessageTool, gmailSearchTool,
} from './tools/gmail.ts'
import {
  Calendar,
  calendarListEventsTool, calendarCreateEventTool, calendarUpdateEventTool, calendarDeleteEventTool,
} from './tools/calendar.ts'
import {
  Drive,
  driveListFilesTool, driveSearchFilesTool, driveGetFileTool, driveDownloadFileTool, driveUploadFileTool,
} from './tools/drive.ts'
import {
  Youtube,
  youtubeSearchVideosTool, youtubeVideoDetailsTool,
} from './tools/youtube.ts'

// ─── Public tool schema ───

export const googleTool = defineTool('google', `Interact with the user's Google Workspace (Gmail, Calendar, Drive, YouTube) via a natural language request. A sub-agent handles the request and returns a summary.

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

**YouTube**:
- "Search YouTube for recent AI news"
- "Get stats and details for YouTube video id xyz"

When uploading a local file, always include its full absolute path in the request (e.g. a path returned by fetch_file or drive_download_file). Never pass just a filename — the sub-agent needs the absolute path to read the file.`, {
  type: 'object',
  properties: {
    request: {
      type: 'string',
      description: 'A natural language instruction describing what to do in Gmail, Calendar, or Drive.',
    },
  },
  required: ['request'],
})

// ─── Plugin state ───

type PluginState = {
  initialized:         boolean
  gen:                 number
  model:               string
  maxToolLoops:        number
  gmailRef:            ActorRef<ToolMsg> | null
  calendarRef:         ActorRef<ToolMsg> | null
  driveRef:            ActorRef<ToolMsg> | null
  youtubeRef:          ActorRef<ToolMsg> | null
  googleAgentRef:      ActorRef<GoogleAgentMsg> | null
  tokenStoreRef:       ActorRef<TokenStoreMsg> | null
  oauthStateRef:       ActorRef<OAuthStateMsg> | null
  clientId:            string
  clientSecret:        string
  baseUrl:             string
}

const config = defineConfig<GoogleApisConfig>('googleapis', {
  clientId:     '',
  clientSecret: '',
  baseUrl:      '',
  agentModel:   'google/gemini-2.5-flash',
  maxToolLoops: 10,
}, {
  schemas: googleapisSchemas,
})

// ─── Helpers ───

type SpawnResult = Pick<PluginState, 'gmailRef' | 'calendarRef' | 'driveRef' | 'youtubeRef' | 'googleAgentRef'>

const spawnChildren = (
  gen:            number,
  model:          string,
  maxToolLoops:   number,
  tokenStoreRef:  ActorRef<TokenStoreMsg>,
  clientId:       string,
  clientSecret:   string,
  ctx:            ActorContext<GooglePluginMsg>,
): SpawnResult => {
  const gmailRef    = ctx.spawn(`googleapis-gmail-${gen}`,    Gmail(tokenStoreRef, clientId, clientSecret))    as ActorRef<ToolMsg>
  const calendarRef = ctx.spawn(`googleapis-calendar-${gen}`, Calendar(tokenStoreRef, clientId, clientSecret)) as ActorRef<ToolMsg>
  const driveRef    = ctx.spawn(`googleapis-drive-${gen}`,    Drive(tokenStoreRef, clientId, clientSecret))    as ActorRef<ToolMsg>
  const youtubeRef  = ctx.spawn(`googleapis-youtube-${gen}`,  Youtube(tokenStoreRef, clientId, clientSecret))  as ActorRef<ToolMsg>

  const tools: ToolCollection = {
    [gmailListMessagesTool.name]:   { ...gmailListMessagesTool,   ref: gmailRef },
    [gmailGetMessageTool.name]:     { ...gmailGetMessageTool,     ref: gmailRef },
    [gmailSendMessageTool.name]:    { ...gmailSendMessageTool,    ref: gmailRef },
    [gmailSearchTool.name]:          { ...gmailSearchTool,          ref: gmailRef },
    [calendarListEventsTool.name]:  { ...calendarListEventsTool,  ref: calendarRef },
    [calendarCreateEventTool.name]: { ...calendarCreateEventTool, ref: calendarRef },
    [calendarUpdateEventTool.name]: { ...calendarUpdateEventTool, ref: calendarRef },
    [calendarDeleteEventTool.name]: { ...calendarDeleteEventTool, ref: calendarRef },
    [driveListFilesTool.name]:      { ...driveListFilesTool,      ref: driveRef },
    [driveSearchFilesTool.name]:    { ...driveSearchFilesTool,    ref: driveRef },
    [driveGetFileTool.name]:        { ...driveGetFileTool,        ref: driveRef },
    [driveDownloadFileTool.name]:   { ...driveDownloadFileTool,   ref: driveRef },
    [driveUploadFileTool.name]:     { ...driveUploadFileTool,     ref: driveRef },
    [youtubeSearchVideosTool.name]: { ...youtubeSearchVideosTool, ref: youtubeRef },
    [youtubeVideoDetailsTool.name]: { ...youtubeVideoDetailsTool, ref: youtubeRef },
  }

  const agentOpts     = { model, maxToolLoops, tools }
  const googleAgentRef = ctx.spawn(
    `googleapis-agent-${gen}`,
    GoogleAgent(agentOpts),
  ) as ActorRef<GoogleAgentMsg>

  ctx.publishRetained(ToolRegistrationTopic, googleTool.name, {
    ...googleTool,
    ref: googleAgentRef as unknown as ActorRef<ToolMsg>,
  })

  return { gmailRef, calendarRef, driveRef, youtubeRef, googleAgentRef }
}

const stopChildren = (state: PluginState, ctx: ActorContext<GooglePluginMsg>): void => {
  if (state.gmailRef)       ctx.stop(state.gmailRef)
  if (state.calendarRef)    ctx.stop(state.calendarRef)
  if (state.driveRef)       ctx.stop(state.driveRef)
  if (state.youtubeRef)     ctx.stop(state.youtubeRef)
  if (state.googleAgentRef) ctx.stop(state.googleAgentRef)
  ctx.deleteRetained(ToolRegistrationTopic, googleTool.name, { name: googleTool.name, ref: null })
}

// ─── Plugin definition ───

const googleApisPlugin: PluginDef<GooglePluginMsg, PluginState, GoogleApisConfig> = {
  id:          'googleapis',
  version:     '1.0.0',
  description: 'Google Workspace integration: Gmail, Calendar, Drive, and YouTube via a single "google" tool.',

  configDescriptor: config,

  initialState: {
    initialized:         false,
    gen:                 0,
    model:               '',
    maxToolLoops:        10,
    gmailRef:            null,
    calendarRef:         null,
    driveRef:            null,
    youtubeRef:          null,
    googleAgentRef:      null,
    tokenStoreRef:       null,
    oauthStateRef:       null,
    clientId:            '',
    clientSecret:        '',
    baseUrl:             '',
  },

  maskState: (state: PluginState) => {
    const { ...safe } = state
    return safe
  },

  lifecycle: onLifecycle({
    start: (state, ctx) => {
      const cfg          = ctx.initialConfig() as GoogleApisConfig | undefined
      const clientId     = cfg?.clientId     ?? ''
      const clientSecret = cfg?.clientSecret ?? ''
      const baseUrl      = (cfg?.baseUrl     ?? '').replace(/\/$/, '')
      const model        = cfg?.agentModel   ?? 'google/gemini-2.5-flash'
      const maxToolLoops = cfg?.maxToolLoops ?? 10

      publishConfigSurface(ctx, config, () => cfg)

      const tokenStoreRef = ctx.spawn('googleapis-token-store', TokenStore('workspace/googleapis/tokens.json'))
      const oauthStateRef = ctx.spawn('googleapis-oauth-state', OAuthState())

      for (const reg of buildGoogleOAuthRoutes({
        tokenStoreRef,
        oauthStateRef,
        clientId,
        clientSecret,
        baseUrl,
      })) {
        ctx.publishRetained(RouteRegistrationTopic, reg.id, reg)
      }

      const children = clientId && clientSecret
        ? spawnChildren(0, model, maxToolLoops, tokenStoreRef, clientId, clientSecret, ctx)
        : { gmailRef: null, calendarRef: null, driveRef: null, youtubeRef: null, googleAgentRef: null }

      ctx.log.info('googleapis plugin activated', { configured: !!(clientId && clientSecret) })
      return { state: {
        ...state,
        initialized: true,
        gen: 0,
        model,
        maxToolLoops,
        tokenStoreRef,
        oauthStateRef,
        clientId,
        clientSecret,
        baseUrl,
        ...children,
      } }
    },

    stopped: (state, ctx) => {
      for (const reg of buildGoogleOAuthRoutes({
        tokenStoreRef: state.tokenStoreRef,
        oauthStateRef: state.oauthStateRef,
        clientId: state.clientId,
        clientSecret: state.clientSecret,
        baseUrl: state.baseUrl,
      })) {
        ctx.deleteRetained(RouteRegistrationTopic, reg.id, { id: reg.id, method: reg.method, path: reg.path, handler: null })
      }
      stopChildren(state, ctx)

      deleteConfigSurface(ctx, config)

      ctx.log.info('googleapis plugin deactivated')
      return { state }
    },
  }),

  handler: onMessage<GooglePluginMsg, PluginState>({
    config: (state, msg, ctx) => {
      // Tombstone old routes
      for (const reg of buildGoogleOAuthRoutes({
        tokenStoreRef: state.tokenStoreRef,
        oauthStateRef: state.oauthStateRef,
        clientId: state.clientId,
        clientSecret: state.clientSecret,
        baseUrl: state.baseUrl,
      })) {
        ctx.deleteRetained(RouteRegistrationTopic, reg.id, { id: reg.id, method: reg.method, path: reg.path, handler: null })
      }

      stopChildren(state, ctx)

      const cfg          = msg.slice
      const clientId     = cfg?.clientId     ?? ''
      const clientSecret = cfg?.clientSecret ?? ''
      const baseUrl      = (cfg?.baseUrl     ?? '').replace(/\/$/, '')
      const model        = cfg?.agentModel   ?? 'google/gemini-2.5-flash'
      const maxToolLoops = cfg?.maxToolLoops ?? 10
      const gen          = state.gen + 1

      // Re-register routes with new config
      for (const reg of buildGoogleOAuthRoutes({
        tokenStoreRef: state.tokenStoreRef,
        oauthStateRef: state.oauthStateRef,
        clientId,
        clientSecret,
        baseUrl,
      })) {
        ctx.publishRetained(RouteRegistrationTopic, reg.id, reg)
      }

      const children = clientId && clientSecret
        ? spawnChildren(gen, model, maxToolLoops, state.tokenStoreRef!, clientId, clientSecret, ctx)
        : { gmailRef: null, calendarRef: null, driveRef: null, youtubeRef: null, googleAgentRef: null }

      return { state: { ...state, gen, model, maxToolLoops, clientId, clientSecret, baseUrl, ...children } }
    },
  }),
}

export default googleApisPlugin
