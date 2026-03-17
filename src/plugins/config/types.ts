import { createTopic } from '../../system/types.ts'
import type { ActorRef } from '../../system/types.ts'
import type { ObservabilityConfig } from '../observability/observability.plugin.ts'
import type { InterfacesConfig } from '../interfaces/interfaces.plugin.ts'
import type { CognitiveConfig } from '../cognitive/cognitive.plugin.ts'
import type { ParallelConfig } from '../parallel/parallel.plugin.ts'

// ─── Master config type — one slice per plugin, keyed by plugin id ───

export type SystemConfig = {
  observability?: ObservabilityConfig
  interfaces?: InterfacesConfig
  cognitive?: CognitiveConfig
  parallel?: ParallelConfig
}

// ─── Config actor message protocol ───

export type ConfigMsg =
  | { type: 'set'; key: keyof SystemConfig; value: SystemConfig[keyof SystemConfig] }
  | { type: 'update'; key: keyof SystemConfig; patch: Partial<SystemConfig[keyof SystemConfig] & object> }
  | { type: 'replace'; config: SystemConfig }
  | { type: 'get'; replyTo: ActorRef<SystemConfig> }

// ─── Topics ───

/** Broadcasts the full SystemConfig on every change. Subscribe to receive config updates. */
export const ConfigTopic = createTopic<SystemConfig>('config.current')

/** Send ConfigMsg commands to the config actor via the event bus. */
export const ConfigCommandTopic = createTopic<ConfigMsg>('config.commands')
