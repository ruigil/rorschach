import { createWebSearchActor, type WebSearchActorOptions, type WebSearchMsg } from './web-search.ts'
import type { ActorIdentity, ActorRef, PluginDef } from '../../system/types.ts'
import { onLifecycle } from '../../system/match.ts'
import { createTopic, redact } from '../../system/types.ts'

export const WebSearchRefTopic = createTopic<ActorRef<WebSearchMsg> | null>('tools/web-search-ref')

export type ToolsConfig = {
  webSearch?: WebSearchActorOptions
}

type PluginMsg = { type: 'config'; slice: ToolsConfig | undefined }
type PluginState = {
  initialized: boolean
  webSearchConfig: WebSearchActorOptions | null
  webSearchRef: ActorIdentity | null
  webSearchGen: number
}

const toolsPlugin: PluginDef<PluginMsg, PluginState, ToolsConfig> = {
  id: 'tools',
  version: '1.0.0',
  description: 'Tool actors: web search and other external integrations',

  configDescriptor: {
    defaults: {
      webSearch: {
        apiKey: process.env.BRAVESEARCH_API_KEY ?? '',
        count: 20,
      },
    },
    onConfigChange: (config) => ({ type: 'config' as const, slice: config }),
  },

  initialState: { initialized: false, webSearchConfig: null, webSearchRef: null, webSearchGen: 0 },

  lifecycle: onLifecycle({
    start: (_state, ctx) => {
      const slice = ctx.config as ToolsConfig | undefined
      const webSearchConfig = slice?.webSearch ?? null
      const webSearchRef = webSearchConfig
        ? ctx.spawn('web-search-0', createWebSearchActor(webSearchConfig), null)
        : null

      ctx.publish(WebSearchRefTopic, webSearchRef)
      ctx.log.info('tools plugin activated')
      return { state: { initialized: true, webSearchConfig, webSearchRef, webSearchGen: 0 } }
    },
    stopped: (state, ctx) => {
      ctx.publish(WebSearchRefTopic, null)
      ctx.log.info('tools plugin deactivating')
      return { state }
    },
  }),

  maskState: (state) => ({
    ...state,
    webSearchConfig: state.webSearchConfig
      ? { ...state.webSearchConfig, apiKey: redact() }
      : null,
  }),

  handler: (state, msg, ctx) => {
    if (state.webSearchRef) ctx.stop(state.webSearchRef)
    const newWebSearch = msg.slice?.webSearch ?? null
    const webSearchGen = state.webSearchGen + 1
    const webSearchRef = newWebSearch
      ? ctx.spawn(`web-search-${webSearchGen}`, createWebSearchActor(newWebSearch), null)
      : null
    ctx.publish(WebSearchRefTopic, webSearchRef)
    return { state: { ...state, webSearchConfig: newWebSearch, webSearchRef, webSearchGen } }
  },
}

export default toolsPlugin
