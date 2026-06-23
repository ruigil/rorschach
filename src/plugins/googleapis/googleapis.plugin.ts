import type { ActorContext, ActorRef, PluginDef } from '../../system/index.ts'
import { defineConfig, publishConfigSurface, deleteConfigSurface } from '../../system/index.ts'
import { onLifecycle, onMessage } from '../../system/index.ts'
import { RouteRegistrationTopic } from '../../types/routes.ts'
import type { ToolCollection, ToolMsg } from '../../types/tools.ts'
import { AgentRegistrationTopic, type AgentDescriptor } from '../../types/agents.ts'

import type { GoogleApisConfig, GooglePluginMsg, GoogleAgentMsg, TokenStoreMsg, OAuthStateMsg } from './types.ts'
import { TokenStore } from './token-store.ts'
import { OAuthState } from './oauth-state.ts'
import { buildGoogleOAuthRoutes, googleapisSchemas } from './routes.ts'
import { GoogleAgentFactory } from './google-agent.ts'

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

const buildGoogleTools = (
  gmailRef:    ActorRef<ToolMsg>,
  calendarRef: ActorRef<ToolMsg>,
  driveRef:    ActorRef<ToolMsg>,
  youtubeRef:  ActorRef<ToolMsg>,
): ToolCollection => ({
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
})



type SpawnResult = Pick<PluginState, 'gmailRef' | 'calendarRef' | 'driveRef' | 'youtubeRef'>

const spawnChildren = (
  gen:            number,
  tokenStoreRef:  ActorRef<TokenStoreMsg>,
  clientId:       string,
  clientSecret:   string,
  ctx:            ActorContext<GooglePluginMsg>,
  cfg:            GoogleApisConfig,
): SpawnResult => {
  const gmailRef    = ctx.spawn(`googleapis-gmail-${gen}`,    Gmail(tokenStoreRef, clientId, clientSecret))    as ActorRef<ToolMsg>
  const calendarRef = ctx.spawn(`googleapis-calendar-${gen}`, Calendar(tokenStoreRef, clientId, clientSecret)) as ActorRef<ToolMsg>
  const driveRef    = ctx.spawn(`googleapis-drive-${gen}`,    Drive(tokenStoreRef, clientId, clientSecret))    as ActorRef<ToolMsg>
  const youtubeRef  = ctx.spawn(`googleapis-youtube-${gen}`,  Youtube(tokenStoreRef, clientId, clientSecret))  as ActorRef<ToolMsg>

  ctx.publish(AgentRegistrationTopic, {
    type: 'register',
    descriptor: GoogleAgentFactory({
      model: cfg.agentModel ?? 'google/gemini-2.5-flash',
      maxToolLoops: cfg.maxToolLoops ?? 10,
      tools: buildGoogleTools(gmailRef, calendarRef, driveRef, youtubeRef),
    }),
  })

  return { gmailRef, calendarRef, driveRef, youtubeRef }
}

const stopChildren = (state: PluginState, ctx: ActorContext<GooglePluginMsg>): void => {
  if (state.gmailRef)       ctx.stop(state.gmailRef)
  if (state.calendarRef)    ctx.stop(state.calendarRef)
  if (state.driveRef)       ctx.stop(state.driveRef)
  if (state.youtubeRef)     ctx.stop(state.youtubeRef)
  ctx.publish(AgentRegistrationTopic, { type: 'unregister', mode: 'google' })
}

// ─── Plugin definition ───

const googleApisPlugin: PluginDef<GooglePluginMsg, PluginState, GoogleApisConfig> = {
  id:          'googleapis',
  version:     '1.0.0',
  description: 'Google Workspace integration: Gmail, Calendar, Drive, and YouTube as a user-facing agent.',

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
        ? spawnChildren(0, tokenStoreRef, clientId, clientSecret, ctx, cfg ?? { agentModel: model, maxToolLoops })
        : { gmailRef: null, calendarRef: null, driveRef: null, youtubeRef: null }

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
        ? spawnChildren(gen, state.tokenStoreRef!, clientId, clientSecret, ctx, cfg ?? { agentModel: model, maxToolLoops })
        : { gmailRef: null, calendarRef: null, driveRef: null, youtubeRef: null }

      return { state: { ...state, gen, model, maxToolLoops, clientId, clientSecret, baseUrl, ...children } }
    },
  }),
}

export default googleApisPlugin
