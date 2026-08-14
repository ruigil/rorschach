import { createPluginFactory } from '../../system/index.ts'
import type { ActorRef } from '../../system/index.ts'
import { RouteRegistrationTopic } from '../../types/routes.ts'

import type { GoogleApisConfig, TokenStoreMsg, OAuthStateMsg } from './types.ts'
import { TokenStore } from './token-store.ts'
import { OAuthState } from './oauth-state.ts'
import { OAuthRouter, type OAuthRouterMsg } from './oauth-router.ts'
import { buildGoogleOAuthRoutes } from './googleapis.routes.ts'
import { config } from './googleapis.config.ts'
import { GoogleAgentDescriptor } from './google-agent.ts'

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

export default createPluginFactory<GoogleApisConfig>({
  id:          'googleapis',
  version:     '1.0.0',
  description: 'Google Workspace integration: Gmail, Calendar, Drive, and YouTube as a user-facing agent.',
  configDescriptor: config,
  maskKeys: ['clientSecret'],
  slots: {
    tokenStore: {
      factory: () => TokenStore(),
      surviveConfigChange: true,
    },
    oauthState: {
      factory: () => OAuthState(),
      surviveConfigChange: true,
    },
    oauthRouter: {
      factory: (cfg, deps) => {
        const clientId     = cfg.clientId     ?? ''
        const clientSecret = cfg.clientSecret ?? ''
        const baseUrl      = (cfg.baseUrl     ?? '').replace(/\/$/, '')
        return OAuthRouter({
          tokenStore: deps.tokenStore as ActorRef<TokenStoreMsg>,
          oauthState: deps.oauthState as ActorRef<OAuthStateMsg>,
          clientId,
          clientSecret,
          baseUrl,
        })
      },
      dependsOn: ['tokenStore', 'oauthState'],
    },
    gmail: {
      factory: (cfg, deps) => {
        if (!cfg.clientId || !cfg.clientSecret) return null
        return Gmail(deps.tokenStore as ActorRef<TokenStoreMsg>, cfg.clientId, cfg.clientSecret)
      },
      dependsOn: ['tokenStore'],
    },
    calendar: {
      factory: (cfg, deps) => {
        if (!cfg.clientId || !cfg.clientSecret) return null
        return Calendar(deps.tokenStore as ActorRef<TokenStoreMsg>, cfg.clientId, cfg.clientSecret)
      },
      dependsOn: ['tokenStore'],
    },
    drive: {
      factory: (cfg, deps) => {
        if (!cfg.clientId || !cfg.clientSecret) return null
        return Drive(deps.tokenStore as ActorRef<TokenStoreMsg>, cfg.clientId, cfg.clientSecret)
      },
      dependsOn: ['tokenStore'],
    },
    youtube: {
      factory: (cfg, deps) => {
        if (!cfg.clientId || !cfg.clientSecret) return null
        return Youtube(deps.tokenStore as ActorRef<TokenStoreMsg>, cfg.clientId, cfg.clientSecret)
      },
      dependsOn: ['tokenStore'],
    },
  },
  tools: {
    gmailListMessages: { schema: gmailListMessagesTool.schema, slot: 'gmail' },
    gmailGetMessage: { schema: gmailGetMessageTool.schema, slot: 'gmail' },
    gmailSendMessage: { schema: gmailSendMessageTool.schema, slot: 'gmail' },
    gmailSearch: { schema: gmailSearchTool.schema, slot: 'gmail' },
    calendarListEvents: { schema: calendarListEventsTool.schema, slot: 'calendar' },
    calendarCreateEvent: { schema: calendarCreateEventTool.schema, slot: 'calendar' },
    calendarUpdateEvent: { schema: calendarUpdateEventTool.schema, slot: 'calendar' },
    calendarDeleteEvent: { schema: calendarDeleteEventTool.schema, slot: 'calendar' },
    driveListFiles: { schema: driveListFilesTool.schema, slot: 'drive' },
    driveSearchFiles: { schema: driveSearchFilesTool.schema, slot: 'drive' },
    driveGetFile: { schema: driveGetFileTool.schema, slot: 'drive' },
    driveDownloadFile: { schema: driveDownloadFileTool.schema, slot: 'drive' },
    driveUploadFile: { schema: driveUploadFileTool.schema, slot: 'drive' },
    youtubeSearchVideos: { schema: youtubeSearchVideosTool.schema, slot: 'youtube' },
    youtubeVideoDetails: { schema: youtubeVideoDetailsTool.schema, slot: 'youtube' },
  },
  agents: {
    google: {
      factory: GoogleAgentDescriptor,
      options: (cfg) => ({
        model: cfg.agentModel ?? 'google/gemini-2.5-flash',
        maxToolLoops: cfg.maxToolLoops ?? 10,
        agentSCRs: [
          'scr:leaf:googleapis.gmailListMessages',
          'scr:leaf:googleapis.gmailGetMessage',
          'scr:leaf:googleapis.gmailSendMessage',
          'scr:leaf:googleapis.gmailSearch',
          'scr:leaf:googleapis.calendarListEvents',
          'scr:leaf:googleapis.calendarCreateEvent',
          'scr:leaf:googleapis.calendarUpdateEvent',
          'scr:leaf:googleapis.calendarDeleteEvent',
          'scr:leaf:googleapis.driveListFiles',
          'scr:leaf:googleapis.driveSearchFiles',
          'scr:leaf:googleapis.driveGetFile',
          'scr:leaf:googleapis.driveDownloadFile',
          'scr:leaf:googleapis.driveUploadFile',
          'scr:leaf:googleapis.youtubeSearchVideos',
          'scr:leaf:googleapis.youtubeVideoDetails',
        ],
      }),
    },
  },
  routes: (cfg, deps) => {
    return buildGoogleOAuthRoutes(deps.oauthRouter as ActorRef<OAuthRouterMsg>)
  },
})
