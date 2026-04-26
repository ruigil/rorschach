import type { ActorRef, SpanHandle } from '../../system/types.ts'
import type { IdentityProviderMsg } from '../../types/identity.ts'
import type { ToolInvokeMsg, ToolReply } from '../../types/tools.ts'
import type { ApiMessage, LlmProviderMsg, LlmProviderReply, ToolCall } from '../../types/llm.ts'

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
  | { type: '_identityProvider'; ref: ActorRef<IdentityProviderMsg> | null }

export type GoogleAgentMsg =
  | ToolInvokeMsg
  | LlmProviderReply
  | { type: '_toolResult'; toolCallId: string; toolName: string; reply: ToolReply }
  | { type: '_llmProviderUpdated'; ref: ActorRef<LlmProviderMsg> | null }

// ─── Shared closure state (passed into route handlers and tool actors) ───

export type SharedRefs = {
  identityProviderRef: ActorRef<IdentityProviderMsg> | null
  tokenStoreRef:       ActorRef<TokenStoreMsg>       | null
  oauthStateRef:       ActorRef<OAuthStateMsg>       | null
  clientId:            string
  clientSecret:        string
  baseUrl:             string   // baseUrl + '/googleapis/auth/callback' = redirectUri
}

// ─── Agent internals ───

export type PendingBatch = {
  remaining:          number
  results:            Array<{ toolCallId: string; toolName: string; content: string }>
  messagesAtCall:     ApiMessage[]
  assistantToolCalls: ToolCall[]
  spans:              Record<string, SpanHandle>
}
