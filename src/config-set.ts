import { resolve, dirname } from 'node:path'
import type { PluginSystem, ActorRef } from './system/index.ts'
import { OutboundAdminBroadcastTopic } from './types/events.ts'
import { saveConfigUnified } from './config.ts'
import { CORE_PLUGIN_IDS } from './types/core-plugins.ts'
import type { PluginSummary } from './plugins/config/types.ts'
import {
  SystemConfigUpdateTopic,
  type SystemConfigUpdateRequest,
  type SystemConfigUpdateResult,
} from './types/config.ts'

export const resolveSpecifier = (specifier: string, configDir: string): string => {
  if (
    specifier.startsWith('https://') ||
    specifier.startsWith('http://') ||
    specifier.startsWith('/') ||
    specifier.startsWith('file://')
  ) {
    return specifier
  }
  return resolve(configDir, specifier)
}

// Matches a whole-string env placeholder: "${VAR}" or "${VAR:-default}".
const ENV_PLACEHOLDER = /^\$\{[^}:-]+(?::-.*)?\}$/

/**
 * Returns a copy of `value` with whole-string env placeholders ("${VAR}")
 * removed (their keys are dropped). Keeps raw placeholder text read from
 * config.json out of the live runtime config tree: the runtime already holds
 * the values interpolated at boot, and re-inserting the literal placeholder
 * text would clobber them until the next restart.
 *
 * Plain objects are recursed; arrays and non-placeholder values pass through.
 */
const stripEnvPlaceholders = (value: unknown): unknown => {
  if (typeof value === 'string') return ENV_PLACEHOLDER.test(value) ? undefined : value
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const stripped = stripEnvPlaceholders(v)
      if (stripped !== undefined) out[k] = stripped
    }
    return out
  }
  return value
}

/**
 * Composition root for the unified config/plugin manager.
 *
 * Subscribes to SystemConfigUpdateTopic and applies each command to the live
 * substrate (AgentSystem) and/or the on-disk config.json.
 *
 * Concurrency: this subscriber is fire-and-forget async. Disk writes are
 * serialized via the single-writer `configSaveQueue` in config.ts, but
 * substrate mutations (`use` / `unloadPlugin` / `updateConfig`) from
 * concurrent messages interleave freely. That is acceptable under the
 * current single-admin assumption — if concurrent admin writers ever become
 * a reality, serialize this handler with a promise mutex.
 */
export const wireConfigManager = (system: PluginSystem, configPath: string): void => {
  system.subscribe(SystemConfigUpdateTopic, async (msg: SystemConfigUpdateRequest) => {
    const { action, replyTo } = msg

    try {
      const configDir = dirname(configPath)

      if (action === 'set_value') {
        const { pluginId, patch } = msg
        if (!pluginId) {
          replyTo?.send({ success: false, error: 'pluginId is required' } satisfies SystemConfigUpdateResult)
          return
        }

        // Runtime: skip raw "${VAR}" placeholder strings — the live tree
        // already holds the interpolated values (see stripEnvPlaceholders).
        // Disk: write the full patch — placeholders on disk are idempotent.
        const runtimePatch = stripEnvPlaceholders(patch) as Record<string, unknown>
        if (Object.keys(runtimePatch).length > 0) {
          system.updateConfig({ [pluginId]: runtimePatch })
        }

        await saveConfigUnified(configPath, () => ({
          config: { [pluginId]: patch },
        }))

        system.publish(OutboundAdminBroadcastTopic, {
          type: 'config.updated',
          key: pluginId,
          payload: { pluginId, patch },
        })

        replyTo?.send({ success: true, message: `Configuration updated for ${pluginId}` })
      } else if (action === 'add_plugin') {
        const { specifier } = msg
        const resolved = resolveSpecifier(specifier, configDir)
        const { default: imported } = await import(resolved)
        let def = imported
        if (typeof imported === 'function') {
          def = imported()
        }

        const existingStatus = system.getPluginStatus(def.id)
        if (existingStatus?.status === 'failed') {
          await system.unloadPlugin(def.id)
        }

        const result = await system.use(def, { modulePath: resolved })
        if (result.ok) {
          await saveConfigUnified(configPath, (curr) => ({
            plugins: Array.from(new Set([...curr.plugins, specifier])),
          }))

          system.publish(OutboundAdminBroadcastTopic, {
            type: 'plugins.updated',
            key: 'system',
            payload: { action: 'add', id: def.id },
          })

          replyTo?.send({ success: true, message: `Plugin ${def.id} added`, details: { id: def.id } })
        } else {
          replyTo?.send({ success: false, error: result.error })
        }
      } else if (action === 'remove_plugin') {
        const { pluginId } = msg
        if (CORE_PLUGIN_IDS.includes(pluginId)) {
          replyTo?.send({ success: false, error: `Cannot unload core plugin: ${pluginId}` })
          return
        }

        const plugin = system.getPluginStatus(pluginId)
        if (!plugin) {
          replyTo?.send({ success: false, error: `Plugin '${pluginId}' not found` })
          return
        }

        const result = await system.unloadPlugin(pluginId)
        if (result.ok) {
          if (plugin.modulePath) {
            await saveConfigUnified(configPath, (curr) => ({
              plugins: curr.plugins.filter((p) => resolveSpecifier(p, configDir) !== plugin.modulePath),
            }))
          }

          system.publish(OutboundAdminBroadcastTopic, {
            type: 'plugins.updated',
            key: 'system',
            payload: { action: 'remove', id: pluginId },
          })

          replyTo?.send({ success: true, message: `Plugin ${pluginId} removed`, details: { id: pluginId } })
        } else {
          replyTo?.send({ success: false, error: result.error })
        }
      } else if (action === 'reload_plugin') {
        const { pluginId } = msg
        const result = await system.hotReloadPlugin(pluginId)
        if (result.ok) {
          system.publish(OutboundAdminBroadcastTopic, {
            type: 'plugins.updated',
            key: 'system',
            payload: { action: 'reload', id: pluginId },
          })

          replyTo?.send({ success: true, message: `Plugin ${pluginId} reloaded`, details: { id: pluginId } })
        } else {
          replyTo?.send({ success: false, error: result.error })
        }
      } else if (action === 'get_values') {
        // Serve the LIVE config tree — env-interpolated at boot and merged
        // with plugin defaults — never the raw file. Raw "${VAR}"
        // placeholders served to clients get echoed back into the runtime on
        // save, corrupting it until restart.
        const { pluginId } = msg
        replyTo?.send({ success: true, details: system.getConfigSlice(pluginId) })
      } else if (action === 'list_plugins') {
        const list: PluginSummary[] = system.listPlugins().map((p) => ({
          id: p.id,
          version: p.version,
          status: p.status,
          modulePath: p.modulePath,
          error: p.error ? String(p.error) : undefined,
          health: p.health,
        }))
        replyTo?.send({ success: true, details: list })
      }
    } catch (err) {
      replyTo?.send({ success: false, error: String(err) })
    }
  })
}
