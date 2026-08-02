import type { ActorRef } from '../../system/index.ts'
import type { Identity } from '../../types/identity.ts'
import type { ToolInvokeMsg } from '../../types/tools.ts'
import type { ConfigSchemaEvent, ConfigSchemaSection } from '../../types/config.ts'
import type { ConfigSource, ObservedPlugin, ObservedState } from '../../system/index.ts'

/** Plugin list entry served by GET /config/plugins. */
export type PluginSummary = ObservedPlugin

export type ConfigPluginConfig = {
  /** Absolute or resolved path to config.json — required for desired-plane access. */
  configPath: string
}

export type ConfigMsg =
  | { type: 'http.request'; request: any; identity?: Identity | null; replyTo: ActorRef<any> }
  | ToolInvokeMsg
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

