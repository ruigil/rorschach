import type { ActorDef } from '../../system/index.ts'
import { onMessage, onLifecycle, parseToolArgs } from '../../system/index.ts'
import { ConfigSchemaTopic, SystemConfigObservedTopic } from '../../types/config.ts'
import { OutboundAdminBroadcastTopic } from '../../types/events.ts'
import { fileSource } from '../../system/index.ts'
import type { ConfigSource, PluginEntry } from '../../system/index.ts'
import { framesFromObservedDiff } from './observed-frames.ts'
import type { ConfigMsg, ConfigPluginConfig, ConfigState, PluginSummary } from './types.ts'

const getBodyText = (body: string | Uint8Array | null | undefined): string => {
  if (!body) return '{}'
  if (typeof body === 'string') return body
  return new TextDecoder().decode(body)
}

const parseHttpBody = (body: unknown): Record<string, unknown> => {
  try {
    const parsed = JSON.parse(getBodyText(body as string | Uint8Array | null | undefined))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

const jsonResponse = (status: number, body: unknown) => ({
  type: 'http.response' as const,
  response: {
    status,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  },
})

// Helper for matching dynamic plugins by ID or modulePath
const isPluginMatch = (
  p: PluginEntry,
  pluginId: string,
  modulePath?: string,
): boolean => {
  if (p.def) {
    return p.def.id === pluginId
  }
  return Boolean(p.modulePath && modulePath && p.modulePath === modulePath)
}

// ─── Direct Config plane mutators and readers ───────────────────────────────

export const getConfig = async (source: ConfigSource, pluginId?: string) => {
  const { state } = await source.read()
  return pluginId === undefined ? state.config : (state.config[pluginId] ?? {})
}

export const setConfig = async (
  source: ConfigSource,
  pluginId: string,
  patch: Record<string, unknown>,
) => {
  return await source.write(() => ({ config: { [pluginId]: patch } }))
}

export const addPlugin = async (source: ConfigSource, modulePath: string) => {
  return await source.write((curr) => {
    const plugins = curr.plugins ?? []
    if (plugins.some((p) => p.modulePath === modulePath)) return { plugins }
    return { plugins: [...plugins, { modulePath }] }
  })
}

export const removePlugin = async (
  source: ConfigSource,
  pluginId: string,
  observedPlugins: PluginSummary[],
) => {
  const modulePath = observedPlugins.find((p) => p.id === pluginId)?.modulePath
  return await source.write((curr) => {
    const next = (curr.plugins ?? []).filter((p) => !isPluginMatch(p, pluginId, modulePath))
    return { plugins: next }
  })
}

export const reloadPlugin = async (
  source: ConfigSource,
  pluginId: string,
  observedPlugins: PluginSummary[],
): Promise<{ revision: string; found: boolean }> => {
  const modulePath = observedPlugins.find((p) => p.id === pluginId)?.modulePath
  let found = false
  const { revision } = await source.write((curr) => {
    const next = (curr.plugins ?? []).map((p) => {
      if (!isPluginMatch(p, pluginId, modulePath)) return p
      found = true
      if (p.def) return p
      const prev = p.reloadNonce ?? 0
      return { ...p, reloadNonce: prev + 1 }
    })
    return found ? { plugins: next } : {}
  })
  return { revision, found }
}

// ─── Config Actor ────────────────────────────────────────────────────────────

export const ConfigActor = (
  initial?: ConfigPluginConfig,
): ActorDef<ConfigMsg, ConfigState> => {
  return {
    initialState: () => {
      const configPath = initial?.configPath ?? ''
      const source: ConfigSource | null = configPath ? fileSource(configPath) : null
      return {
        schemas: new Map(),
        source,
        configPath,
        observed: {},
      }
    },

    handler: onMessage<ConfigMsg, ConfigState>({
      _observed: (state, { systemId, observed }, ctx) => {
        const prev = state.observed[systemId] ?? null
        for (const frame of framesFromObservedDiff(prev, observed)) {
          ctx.publish(OutboundAdminBroadcastTopic, frame)
        }
        return { state: { ...state, observed: { ...state.observed, [systemId]: observed } } }
      },

      _configSchemaChanged: (state, { event }, ctx) => {
        if (!event.payload?.section) return { state }
        const schemas = new Map(state.schemas)
        if (event.isTombstone) {
          schemas.delete(event.key)
        } else {
          schemas.set(event.key, event.payload.section)
        }
        ctx.publish(OutboundAdminBroadcastTopic, {
          type: 'config.schema',
          key: event.key,
          payload: event.payload,
          ...(event.isTombstone ? { isTombstone: true } : {}),
        })
        return { state: { ...state, schemas } }
      },

      'http.request': (state, { request, replyTo }) => {
        if (!state.source) {
          replyTo.send(jsonResponse(500, { accepted: false, error: 'configPath not configured' }))
          return { state }
        }
        const source = state.source
        const url = new URL(request.url, 'http://localhost')
        const path = url.pathname
        // Single-source today: default to 'local'. Multi-system admin targets
        // a system via ?systemId= (observed stays keyed per system regardless).
        const systemId = url.searchParams.get('systemId') ?? 'local'
        const observedPlugins = state.observed[systemId]?.plugins ?? []

        if (request.method === 'GET' && path === '/config/schema') {
          replyTo.send(jsonResponse(200, Array.from(state.schemas.values())))
          return { state }
        }

        const handleHttpRequest = async () => {
          try {
            if (request.method === 'GET') {
              if (path === '/config/systems') {
                replyTo.send(
                  jsonResponse(
                    200,
                    Object.values(state.observed).map((o) => ({
                      systemId: o.systemId,
                      plugins: o.plugins,
                      revision: o.revision,
                      appliedRevision: o.appliedRevision,
                    })),
                  ),
                )
                return
              }
              if (path === '/config/plugins') {
                replyTo.send(jsonResponse(200, observedPlugins))
                return
              }
              if (path === '/config') {
                const data = await getConfig(source)
                replyTo.send(jsonResponse(200, data))
                return
              }
              if (path.startsWith('/config/values/')) {
                const pluginId = path.match(/^\/config\/values\/(.+)$/)?.[1]
                if (!pluginId) {
                  replyTo.send(jsonResponse(400, { accepted: false, error: 'pluginId is required' }))
                  return
                }
                const data = await getConfig(source, pluginId)
                replyTo.send(jsonResponse(200, data))
                return
              }
            }

            if (request.method === 'PATCH' && path.startsWith('/config/values/')) {
              const pluginId = path.match(/^\/config\/values\/(.+)$/)?.[1]
              if (!pluginId) {
                replyTo.send(jsonResponse(400, { accepted: false, error: 'pluginId is required' }))
                return
              }
              const patch = parseHttpBody(request.body)
              const { revision } = await setConfig(source, pluginId, patch)
              replyTo.send(jsonResponse(200, { accepted: true, revision }))
              return
            }

            if (request.method === 'POST') {
              if (path === '/config/plugins/add') {
                const body = parseHttpBody(request.body)
                const modulePath = String(body.modulePath ?? body.specifier ?? '')
                if (!modulePath) {
                  replyTo.send(jsonResponse(400, { accepted: false, error: 'modulePath is required' }))
                  return
                }
                const { revision } = await addPlugin(source, modulePath)
                replyTo.send(jsonResponse(200, { accepted: true, revision, details: { modulePath } }))
                return
              }

              if (path === '/config/plugins/remove') {
                const body = parseHttpBody(request.body)
                const pluginId = String(body.pluginId ?? '')
                if (!pluginId) {
                  replyTo.send(jsonResponse(400, { accepted: false, error: 'pluginId is required' }))
                  return
                }
                const { revision } = await removePlugin(source, pluginId, observedPlugins)
                replyTo.send(jsonResponse(200, { accepted: true, revision, details: { id: pluginId } }))
                return
              }

              if (path === '/config/plugins/reload') {
                const body = parseHttpBody(request.body)
                const pluginId = String(body.pluginId ?? '')
                if (!pluginId) {
                  replyTo.send(jsonResponse(400, { accepted: false, error: 'pluginId is required' }))
                  return
                }
                const { revision, found } = await reloadPlugin(source, pluginId, observedPlugins)
                if (!found) {
                  replyTo.send(
                    jsonResponse(400, {
                      accepted: false,
                      error: `Plugin '${pluginId}' not found in desired state`,
                    }),
                  )
                  return
                }
                replyTo.send(jsonResponse(200, { accepted: true, revision, details: { id: pluginId } }))
                return
              }
            }

            replyTo.send(jsonResponse(404, { error: 'Route not found' }))
          } catch (err) {
            replyTo.send(jsonResponse(500, { accepted: false, error: String(err) }))
          }
        }
        
        handleHttpRequest()
        return { state }
      },

      invoke: (state, { urn, input, replyTo }) => {
        if (!state.source) {
          replyTo.send({ type: 'error', error: 'configPath not configured' })
          return { state }
        }
        const source = state.source
        const observedPlugins = state.observed['local']?.plugins ?? []

        const handleToolInvoke = async () => {
          try {
            const parsed = parseToolArgs(input, (obj) => obj)
            if (!parsed.ok) {
              replyTo.send({ type: 'error', error: parsed.error })
              return
            }
            const params = parsed.value

            const isGet = urn.endsWith('config_get') || urn.endsWith('get')
            const isSet = urn.endsWith('config_set') || urn.endsWith('set')
            const isLoad = urn.endsWith('plugins_load') || urn.endsWith('load')
            const isUnload = urn.endsWith('plugins_unload') || urn.endsWith('unload')
            const isReload = urn.endsWith('plugins_reload') || urn.endsWith('reload')

            if (isGet) {
              const pluginId = typeof params.pluginId === 'string' ? params.pluginId : undefined
              const data = await getConfig(source, pluginId)
              replyTo.send({ type: 'result', output: { text: JSON.stringify(data, null, 2) } })
              return
            }

            if (isSet) {
              const pluginId = String(params.pluginId ?? '')
              if (!pluginId) {
                replyTo.send({ type: 'error', error: 'pluginId is required' })
                return
              }
              const patch = (params.patch as Record<string, unknown>) ?? {}
              const { revision } = await setConfig(source, pluginId, patch)
              replyTo.send({
                type: 'result',
                output: { text: JSON.stringify({ accepted: true, revision }) },
              })
              return
            }

            if (isLoad) {
              const modulePath = String(params.modulePath ?? '')
              if (!modulePath) {
                replyTo.send({ type: 'error', error: 'modulePath is required' })
                return
              }
              const { revision } = await addPlugin(source, modulePath)
              replyTo.send({
                type: 'result',
                output: { text: JSON.stringify({ accepted: true, revision, details: { modulePath } }) },
              })
              return
            }

            if (isUnload) {
              const pluginId = String(params.pluginId ?? '')
              if (!pluginId) {
                replyTo.send({ type: 'error', error: 'pluginId is required' })
                return
              }
              const { revision } = await removePlugin(source, pluginId, observedPlugins)
              replyTo.send({
                type: 'result',
                output: { text: JSON.stringify({ accepted: true, revision, details: { id: pluginId } }) },
              })
              return
            }

            if (isReload) {
              const pluginId = String(params.pluginId ?? '')
              if (!pluginId) {
                replyTo.send({ type: 'error', error: 'pluginId is required' })
                return
              }
              const { revision, found } = await reloadPlugin(source, pluginId, observedPlugins)
              if (!found) {
                replyTo.send({
                  type: 'error',
                  error: `Plugin '${pluginId}' not found in desired state`,
                })
                return
              }
              replyTo.send({
                type: 'result',
                output: { text: JSON.stringify({ accepted: true, revision, details: { id: pluginId } }) },
              })
              return
            }

            replyTo.send({ type: 'error', error: `Unknown tool: ${urn}` })
          } catch (err) {
            replyTo.send({ type: 'error', error: String(err) })
          }
        }
        
        handleToolInvoke()
        return { state }
      },
    }),

    lifecycle: onLifecycle({
      start: (state, ctx) => {
        if (!state.configPath) {
          console.warn(
            '[config] configPath is empty — desired-plane mutations will fail until configured',
          )
        }
        ctx.subscribe(ConfigSchemaTopic, (e) => ({
          type: '_configSchemaChanged' as const,
          event: e,
        }))
        ctx.subscribe(SystemConfigObservedTopic, (e) => ({
          type: '_observed' as const,
          systemId: e.systemId,
          observed: e,
        }))
        return { state }
      },
    }),
  }
}
