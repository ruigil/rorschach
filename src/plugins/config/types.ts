import type { ActorRef } from '../../system/index.ts'
import type { Identity } from '../../types/identity.ts'
import type { ToolInvokeMsg } from '../../types/tools.ts'
import type { ConfigSchemaEvent, ConfigSchemaSection } from '../../types/config.ts'
import type { ConfigSource, ObservedPlugin, ObservedState } from '../../system/index.ts'

/** Plugin list entry served by GET /config/plugins. */
export type PluginSummary = ObservedPlugin

export type { ConfigPluginConfig } from './config.config.ts'

export type ConfigMsg =
  | { type: 'http.request'; request: any; identity?: Identity | null; replyTo: ActorRef<any> }
  | ToolInvokeMsg
  | { type: '_configSchemaChanged'; event: ConfigSchemaEvent }
  | { type: '_observed'; systemId: string; observed: ObservedState }

export type ConfigState = {
  schemas: Map<string, ConfigSchemaSection>
  source: ConfigSource | null
  configPath: string
  /**
   * Observed snapshots keyed by systemId, from system.config.observed.
   * Base for multi-system: node-control publishes one retained value per system.
   * No parallel observed* fields — plugin list + revision lag live here.
   */
  observed: Record<string, ObservedState>
}

