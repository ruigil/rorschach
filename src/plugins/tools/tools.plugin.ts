import { createWebSearchActor, type WebSearchActorOptions, WEB_SEARCH_SCHEMA, WEB_SEARCH_TOOL_NAME } from './web-search.ts'
import { createBashActor, BASH_TOOL_NAME, BASH_SCHEMA, WRITE_TOOL_NAME, WRITE_SCHEMA, READ_TOOL_NAME, READ_SCHEMA } from './bash.ts'
import type { BashOptions } from 'just-bash'
import type { ActorIdentity, ActorRef, PluginDef } from '../../system/types.ts'
import { onLifecycle, onMessage } from '../../system/match.ts'
import { redact } from '../../system/types.ts'
import type { ToolCollection, ToolInvokeMsg, ToolSchema } from '../../system/tools.ts'
import { ToolRegistrationTopic } from '../../system/tools.ts'

export type ToolsConfig = {
  webSearch?: WebSearchActorOptions
  bash?: BashOptions
}

type PluginMsg =
  | { type: 'config'; slice: ToolsConfig | undefined }
  | { type: 'getTools'; replyTo: ActorRef<ToolCollection> }
  | { type: '_toolRegistered'; name: string; schema: ToolSchema; ref: ActorRef<ToolInvokeMsg> }
  | { type: '_toolUnregistered'; name: string }

type ToolActorState<C> = {
  config: C | null
  ref: ActorIdentity | null
  gen: number
}

type PluginState = {
  initialized: boolean
  webSearch: ToolActorState<WebSearchActorOptions>
  bash: ToolActorState<BashOptions>
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
      bash:{
        cwd: "/home/rorschach"
      },
    },
    onConfigChange: (config) => ({ type: 'config' as const, slice: config }),
  },

  initialState: {
    initialized: false,
    webSearch: { config: null, ref: null, gen: 0 },
    bash:      { config: null, ref: null, gen: 0 },
    tools: {},
  },

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

      const bashConfig = slice?.bash ?? null
      const bashRef = ctx.spawn('bash-0', createBashActor(bashConfig ?? undefined), null) as ActorRef<ToolInvokeMsg>
      tools = {
        ...tools,
        [BASH_TOOL_NAME]:  { schema: BASH_SCHEMA,  ref: bashRef },
        [WRITE_TOOL_NAME]: { schema: WRITE_SCHEMA, ref: bashRef },
        [READ_TOOL_NAME]:  { schema: READ_SCHEMA,  ref: bashRef },
      }
      ctx.publish(ToolRegistrationTopic, { name: BASH_TOOL_NAME,  schema: BASH_SCHEMA,  ref: bashRef })
      ctx.publish(ToolRegistrationTopic, { name: WRITE_TOOL_NAME, schema: WRITE_SCHEMA, ref: bashRef })
      ctx.publish(ToolRegistrationTopic, { name: READ_TOOL_NAME,  schema: READ_SCHEMA,  ref: bashRef })

      // Subscribe to ToolRegistrationTopic so other plugins (e.g. cognitive) can register their tools
      ctx.subscribe(ToolRegistrationTopic, (event) =>
        event.ref === null
          ? { type: '_toolUnregistered' as const, name: event.name }
          : { type: '_toolRegistered' as const, name: event.name, schema: event.schema, ref: event.ref },
      )

      ctx.registerService('tools', ctx.self as ActorRef<unknown>)
      ctx.log.info('tools plugin activated')
      return { state: {
        initialized: true,
        webSearch: { config: webSearchConfig, ref: webSearchRef, gen: 0 },
        bash:      { config: bashConfig, ref: bashRef, gen: 0 },
        tools,
      } }
    },

    stopped: (state, ctx) => {
      if (state.webSearch.ref) {
        ctx.publish(ToolRegistrationTopic, { name: WEB_SEARCH_TOOL_NAME, ref: null })
      }
      if (state.bash.ref) {
        ctx.publish(ToolRegistrationTopic, { name: BASH_TOOL_NAME,  ref: null })
        ctx.publish(ToolRegistrationTopic, { name: WRITE_TOOL_NAME, ref: null })
        ctx.publish(ToolRegistrationTopic, { name: READ_TOOL_NAME,  ref: null })
      }
      ctx.unregisterService('tools')
      ctx.log.info('tools plugin deactivating')
      return { state }
    },
  }),

  maskState: (state) => ({
    ...state,
    webSearch: {
      ...state.webSearch,
      config: state.webSearch.config
        ? { ...state.webSearch.config, apiKey: redact() }
        : null,
    },
  }),

  handler: onMessage<PluginMsg, PluginState>({
    getTools: (state, msg) => {
      msg.replyTo.send(state.tools)
      return { state }
    },

    _toolRegistered: (state, msg) => ({
      state: { ...state, tools: { ...state.tools, [msg.name]: { schema: msg.schema, ref: msg.ref } } },
    }),

    _toolUnregistered: (state, msg) => {
      const { [msg.name]: _, ...rest } = state.tools
      return { state: { ...state, tools: rest } }
    },

    config: (state, msg, ctx) => {
      if (state.webSearch.ref) {
        ctx.stop(state.webSearch.ref)
        ctx.publish(ToolRegistrationTopic, { name: WEB_SEARCH_TOOL_NAME, ref: null })
      }
      if (state.bash.ref) {
        ctx.stop(state.bash.ref)
        ctx.publish(ToolRegistrationTopic, { name: BASH_TOOL_NAME,  ref: null })
        ctx.publish(ToolRegistrationTopic, { name: WRITE_TOOL_NAME, ref: null })
        ctx.publish(ToolRegistrationTopic, { name: READ_TOOL_NAME,  ref: null })
      }

      const newWebSearchConfig = msg.slice?.webSearch ?? null
      const webSearchGen = state.webSearch.gen + 1
      const newBashConfig = msg.slice?.bash ?? null
      const bashGen = state.bash.gen + 1

      let tools: ToolCollection = {}
      let webSearchRef: ActorRef<ToolInvokeMsg> | null = null

      if (newWebSearchConfig) {
        webSearchRef = ctx.spawn(`web-search-${webSearchGen}`, createWebSearchActor(newWebSearchConfig), null) as ActorRef<ToolInvokeMsg>
        tools = { [WEB_SEARCH_TOOL_NAME]: { schema: WEB_SEARCH_SCHEMA, ref: webSearchRef } }
        ctx.publish(ToolRegistrationTopic, { name: WEB_SEARCH_TOOL_NAME, schema: WEB_SEARCH_SCHEMA, ref: webSearchRef })
      }

      const bashRef = ctx.spawn(`bash-${bashGen}`, createBashActor(newBashConfig ?? undefined), null) as ActorRef<ToolInvokeMsg>
      tools = {
        ...tools,
        [BASH_TOOL_NAME]:  { schema: BASH_SCHEMA,  ref: bashRef },
        [WRITE_TOOL_NAME]: { schema: WRITE_SCHEMA, ref: bashRef },
        [READ_TOOL_NAME]:  { schema: READ_SCHEMA,  ref: bashRef },
      }
      ctx.publish(ToolRegistrationTopic, { name: BASH_TOOL_NAME,  schema: BASH_SCHEMA,  ref: bashRef })
      ctx.publish(ToolRegistrationTopic, { name: WRITE_TOOL_NAME, schema: WRITE_SCHEMA, ref: bashRef })
      ctx.publish(ToolRegistrationTopic, { name: READ_TOOL_NAME,  schema: READ_SCHEMA,  ref: bashRef })

      return { state: {
        ...state,
        webSearch: { config: newWebSearchConfig, ref: webSearchRef, gen: webSearchGen },
        bash:      { config: newBashConfig, ref: bashRef, gen: bashGen },
        tools,
      } }
    },
  }),
}

export default toolsPlugin
