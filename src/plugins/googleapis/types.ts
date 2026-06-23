import type { ActorRef, LoopMsg, LoopState, ContextView } from '../../system/index.ts'
import type { ToolCollection, ToolSchema, ToolMsg } from '../../types/tools.ts'
import type { ContextSnapshotEvent, AgentModelOptions } from '../../types/agents.ts'
import type { MessageAttachment } from '../../types/events.ts'

// ─── Domain types ───

export type GoogleToken = {
  access_token:  string
  refresh_token: string
  expiry_date:   number   // ms since epoch
  scope:         string
  token_type:    string
}

export type GoogleApisConfig = {
  clientId?:     string
  clientSecret?: string
  baseUrl?:      string
  agentModel?:   string
  maxToolLoops?: number
}

// ─── Actor message protocols ───

export type TokenStoreMsg =
  | { type: 'getToken';    userId: string; replyTo: ActorRef<GoogleToken | null> }
  | { type: 'setToken';    userId: string; token: GoogleToken }
  | { type: 'deleteToken'; userId: string }

export type OAuthStateMsg =
  | { type: 'createState';  userId: string; replyTo: ActorRef<string> }
  | { type: 'resolveState'; state: string;  replyTo: ActorRef<string | null> }
  | { type: '_expire';      state: string }

export type GooglePluginMsg =
  | { type: 'config';            slice: GoogleApisConfig | undefined }

export type GoogleAgentExtraMsg =
  | { type: 'userMessage'; text: string; attachments?: MessageAttachment[]; isInjected?: boolean }
  | ({ type: '_contextSnapshot' } & ContextSnapshotEvent)
  | { type: '_toolRegistered'; name: string; schema: ToolSchema; ref: ActorRef<ToolMsg>; mayBeLongRunning?: boolean }
  | { type: '_toolUnregistered'; name: string }

export type GoogleAgentMsg = LoopMsg<GoogleAgentExtraMsg>

export type GoogleAgentState = {
  loop:        LoopState
  contextView: ContextView
  tools:       ToolCollection
}

export type GoogleAgentOptions = AgentModelOptions & {
  tools: ToolCollection
}

// ─── Route handler options (passed into route factories) ───

export type GoogleOAuthRouteOpts = {
  tokenStoreRef:       ActorRef<TokenStoreMsg>       | null
  oauthStateRef:       ActorRef<OAuthStateMsg>       | null
  clientId:            string
  clientSecret:        string
  baseUrl:             string   // baseUrl + '/googleapis/auth/callback' = redirectUri
}

