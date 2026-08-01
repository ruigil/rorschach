import type { ActorRef } from '../../system/index.ts'
import type { Identity } from '../../types/identity.ts'
import type { ConfigSchemaEvent, ConfigSchemaSection } from '../../types/config.ts'
import type { ConfigSource, ObservedPlugin, ObservedState } from '../../system/node/types.ts'

/** Plugin list entry served by GET /config/plugins. */
export type PluginSummary = ObservedPlugin

export type ConfigPluginConfig = {
  /** Absolute or resolved path to config.json — required for desired-plane access. */
  configPath: string
}

export type ConfigMsg =
  | { type: 'http.request'; request: any; identity?: Identity | null; replyTo: ActorRef<any> }
  | { type: 'tool.invoke'; toolCallId: string; toolName: string; args: Record<string, unknown>; replyTo: ActorRef<any> }
  | { type: '_configSchemaChanged'; event: ConfigSchemaEvent }
  | { type: '_observed'; observed: ObservedState }
  | { type: 'config'; slice: ConfigPluginConfig }

export type ConfigState = {
  schemas: Map<string, ConfigSchemaSection>
  source: ConfigSource | null
  configPath: string
  /**
   * Sole observed snapshot from system.observed (null until first retain).
   * Plugin list + revision lag live here — no parallel observed* fields.
   */
  observed: ObservedState | null
}

export type ConfigGetArgs = { pluginId?: string }
export type ConfigSetArgs = { pluginId: string; patch: Record<string, unknown> }
export type PluginsLoadArgs = { modulePath: string }
export type PluginsUnloadArgs = { pluginId: string }
export type PluginsReloadArgs = { pluginId: string }
