import type { ActorRef, LoadedPlugin } from '../../system/index.ts'
import type { Identity } from '../../types/identity.ts'
import type { ConfigSchemaEvent, ConfigSchemaSection, SystemConfigUpdateResult } from '../../types/config.ts'

/** Plugin list entry served by GET /config/plugins — a view over LoadedPlugin
 *  with the internal def/ref/loadedAt fields omitted and `error` stringified
 *  for UI display. */
export type PluginSummary = Pick<LoadedPlugin, 'id' | 'version' | 'status' | 'modulePath' | 'health'> & {
  error?: string
}

/** A request awaiting a SystemConfigUpdateTopic reply. */
export type PendingRequest =
  | { type: 'http'; replyTo: ActorRef<any>; extra?: { action: 'get' | 'list'; pluginId?: string } }
  | { type: 'tool'; replyTo: ActorRef<any> }

export type ConfigMsg =
  | { type: 'http.request'; request: any; identity?: Identity | null; replyTo: ActorRef<any> }
  | { type: 'tool.invoke'; toolCallId: string; toolName: string; args: Record<string, unknown>; replyTo: ActorRef<any> }
  | { type: '_updateReply'; requestId: string; result: SystemConfigUpdateResult }
  | { type: '_requestTimeout'; requestId: string }
  | { type: '_configSchemaChanged'; event: ConfigSchemaEvent }

export type ConfigState = {
  schemas: Map<string, ConfigSchemaSection>
  pendingRequests: Map<string, PendingRequest>
  nextRequestId: number
}

export type ConfigGetArgs = { pluginId?: string }
export type ConfigSetArgs = { pluginId: string; patch: Record<string, unknown> }
export type PluginsLoadArgs = { specifier: string }
export type PluginsUnloadArgs = { pluginId: string }
export type PluginsReloadArgs = { pluginId: string }
