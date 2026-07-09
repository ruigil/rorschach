import { createPluginFactory, defineConfig } from '../../system/index.ts'
import type { ActorRef } from '../../system/index.ts'
import { RouteRegistrationTopic } from '../../types/routes.ts'
import type { ToolCollection, ToolMsg } from '../../types/tools.ts'

import type { GoogleApisConfig, TokenStoreMsg, OAuthStateMsg } from './types.ts'
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

const config = defineConfig<GoogleApisConfig>('googleapis', {
  clientId:     '',
  clientSecret: '',
  baseUrl:      '',
  agentModel:   'google/gemini-2.5-flash',
  maxToolLoops: 10,
}, {
  schemas: googleapisSchemas,
})

const buildGoogleTools = (
  gmailRef:    ActorRef<ToolMsg> | null,
  calendarRef: ActorRef<ToolMsg> | null,
  driveRef:    ActorRef<ToolMsg> | null,
  youtubeRef:  ActorRef<ToolMsg> | null,
): ToolCollection => {
  const tools: ToolCollection = {}
  if (gmailRef) {
    tools[gmailListMessagesTool.name] = { ...gmailListMessagesTool, ref: gmailRef }
    tools[gmailGetMessageTool.name]   = { ...gmailGetMessageTool, ref: gmailRef }
    tools[gmailSendMessageTool.name]  = { ...gmailSendMessageTool, ref: gmailRef }
    tools[gmailSearchTool.name]       = { ...gmailSearchTool, ref: gmailRef }
  }
  if (calendarRef) {
    tools[calendarListEventsTool.name]  = { ...calendarListEventsTool, ref: calendarRef }
    tools[calendarCreateEventTool.name] = { ...calendarCreateEventTool, ref: calendarRef }
    tools[calendarUpdateEventTool.name] = { ...calendarUpdateEventTool, ref: calendarRef }
    tools[calendarDeleteEventTool.name] = { ...calendarDeleteEventTool, ref: calendarRef }
  }
  if (driveRef) {
    tools[driveListFilesTool.name]    = { ...driveListFilesTool, ref: driveRef }
    tools[driveSearchFilesTool.name]  = { ...driveSearchFilesTool, ref: driveRef }
    tools[driveGetFileTool.name]      = { ...driveGetFileTool, ref: driveRef }
    tools[driveDownloadFileTool.name] = { ...driveDownloadFileTool, ref: driveRef }
    tools[driveUploadFileTool.name]   = { ...driveUploadFileTool, ref: driveRef }
  }
  if (youtubeRef) {
    tools[youtubeSearchVideosTool.name] = { ...youtubeSearchVideosTool, ref: youtubeRef }
    tools[youtubeVideoDetailsTool.name] = { ...youtubeVideoDetailsTool, ref: youtubeRef }
  }
  return tools
}

export default createPluginFactory<GoogleApisConfig>({
  id:          'googleapis',
  version:     '1.0.0',
  description: 'Google Workspace integration: Gmail, Calendar, Drive, and YouTube as a user-facing agent.',
  configDescriptor: config,
  slots: {
    tokenStore: {
      factory: () => TokenStore(),
      surviveConfigChange: true,
    },
    oauthState: {
      factory: () => OAuthState(),
      surviveConfigChange: true,
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
  agents: {
    google: {
      factory: GoogleAgentFactory,
      options: (cfg, deps) => ({
        model: cfg.agentModel ?? 'google/gemini-2.5-flash',
        maxToolLoops: cfg.maxToolLoops ?? 10,
        tools: buildGoogleTools(
          (deps.gmail as ActorRef<ToolMsg>) ?? null,
          (deps.calendar as ActorRef<ToolMsg>) ?? null,
          (deps.drive as ActorRef<ToolMsg>) ?? null,
          (deps.youtube as ActorRef<ToolMsg>) ?? null,
        ),
      }),
      dependsOn: ['gmail', 'calendar', 'drive', 'youtube'],
    },
  },
  routes: (cfg, deps) => {
    const clientId     = cfg.clientId     ?? ''
    const clientSecret = cfg.clientSecret ?? ''
    const baseUrl      = (cfg.baseUrl     ?? '').replace(/\/$/, '')
    return buildGoogleOAuthRoutes({
      tokenStoreRef: deps.tokenStore as ActorRef<TokenStoreMsg>,
      oauthStateRef: deps.oauthState as ActorRef<OAuthStateMsg>,
      clientId,
      clientSecret,
      baseUrl,
    })
  },
})
