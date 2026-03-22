import { createWebSearchActor, type WebSearchActorOptions, WEB_SEARCH_SCHEMA, WEB_SEARCH_TOOL_NAME } from './web-search.ts'
import type { ActorIdentity, ActorRef, PluginDef } from '../../system/types.ts'
import { onLifecycle } from '../../system/match.ts'
import { redact } from '../../system/types.ts'
import type { ToolCollection, ToolInvokeMsg, ToolSchema } from './tool.ts'
import { ToolRegistrationTopic } from './tool.ts'

export { ToolRegistrationTopic } from './tool.ts'
export type { ToolCollection } from './tool.ts'

export type GetToolsMsg = { type: 'getTools'; replyTo: ActorRef<ToolCollection> }

export type ToolsConfig = {
  webSearch?: WebSearchActorOptions
}

type PluginMsg =
  | { type: 'config'; slice: ToolsConfig | undefined }
  | { type: 'getTools'; replyTo: ActorRef<ToolCollection> }
  | { type: '_toolRegistered'; name: string; schema: ToolSchema; ref: ActorRef<ToolInvokeMsg> }
  | { type: '_toolUnregistered'; name: string }

type PluginState = {
  initialized: boolean
  webSearchConfig: WebSearchActorOptions | null
  webSearchRef: ActorIdentity | null
  webSearchGen: number
  tools: ToolCollection
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

  initialState: { initialized: false, webSearchConfig: null, webSearchRef: null, webSearchGen: 0, tools: {} },

  lifecycle: onLifecycle({
    start: (_state, ctx) => {
      const slice = ctx.config as ToolsConfig | undefined
      const webSearchConfig = slice?.webSearch ?? null

      let tools: ToolCollection = {}
      let webSearchRef: ActorRef<ToolInvokeMsg> | null = null

      if (webSearchConfig) {
        webSearchRef = ctx.spawn('web-search-0', createWebSearchActor(webSearchConfig), null) as ActorRef<ToolInvokeMsg>
        tools = { [WEB_SEARCH_TOOL_NAME]: { schema: WEB_SEARCH_SCHEMA, ref: webSearchRef } }
        ctx.publish(ToolRegistrationTopic, { name: WEB_SEARCH_TOOL_NAME, schema: WEB_SEARCH_SCHEMA, ref: webSearchRef })
      }

      // Subscribe to ToolRegistrationTopic so other plugins (e.g. cognitive) can register their tools
      ctx.subscribe(ToolRegistrationTopic, (event) =>
        event.ref === null
          ? { type: '_toolUnregistered' as const, name: event.name }
          : { type: '_toolRegistered' as const, name: event.name, schema: event.schema, ref: event.ref },
      )

      ctx.log.info('tools plugin activated')
      return { state: { initialized: true, webSearchConfig, webSearchRef, webSearchGen: 0, tools } }
    },

    stopped: (state, ctx) => {
      if (state.webSearchRef) {
        ctx.publish(ToolRegistrationTopic, { name: WEB_SEARCH_TOOL_NAME, ref: null })
      }
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
    if (msg.type === 'getTools') {
      msg.replyTo.send(state.tools)
      return { state }
    }

    if (msg.type === '_toolRegistered') {
      return { state: { ...state, tools: { ...state.tools, [msg.name]: { schema: msg.schema, ref: msg.ref } } } }
    }

    if (msg.type === '_toolUnregistered') {
      const { [msg.name]: _, ...rest } = state.tools
      return { state: { ...state, tools: rest } }
    }

    // config update
    if (state.webSearchRef) ctx.stop(state.webSearchRef)
    if (state.webSearchRef) {
      ctx.publish(ToolRegistrationTopic, { name: WEB_SEARCH_TOOL_NAME, ref: null })
    }

    const newWebSearch = msg.slice?.webSearch ?? null
    const webSearchGen = state.webSearchGen + 1

    let tools: ToolCollection = {}
    let webSearchRef: ActorRef<ToolInvokeMsg> | null = null

    if (newWebSearch) {
      webSearchRef = ctx.spawn(`web-search-${webSearchGen}`, createWebSearchActor(newWebSearch), null) as ActorRef<ToolInvokeMsg>
      tools = { [WEB_SEARCH_TOOL_NAME]: { schema: WEB_SEARCH_SCHEMA, ref: webSearchRef } }
      ctx.publish(ToolRegistrationTopic, { name: WEB_SEARCH_TOOL_NAME, schema: WEB_SEARCH_SCHEMA, ref: webSearchRef })
    }

    return { state: { ...state, webSearchConfig: newWebSearch, webSearchRef, webSearchGen, tools } }
  },
}

export default toolsPlugin
