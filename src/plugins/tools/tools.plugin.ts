import { createWebSearchActor, type WebSearchActorOptions, WEB_SEARCH_SCHEMA, WEB_SEARCH_TOOL_NAME } from './web-search.ts'
import { createBashActor, BASH_TOOL_NAME, BASH_SCHEMA, WRITE_TOOL_NAME, WRITE_SCHEMA, READ_TOOL_NAME, READ_SCHEMA } from './bash.ts'
import type { BashOptions } from 'just-bash'
import type { ActorIdentity, ActorRef, PluginDef } from '../../system/types.ts'
import { onLifecycle, onMessage } from '../../system/match.ts'
import { redact } from '../../system/types.ts'
import type { ToolInvokeMsg } from '../../system/tools.ts'
import { ToolRegistrationTopic } from '../../system/tools.ts'

export type ToolsConfig = {
  webSearch?: WebSearchActorOptions
  bash?: BashOptions
}

type PluginMsg =
  | { type: 'config'; slice: ToolsConfig | undefined }

type ToolActorState<C> = {
  config: C | null
  ref: ActorIdentity | null
  gen: number
}

type PluginState = {
  initialized: boolean
  webSearch: ToolActorState<WebSearchActorOptions>
  bash: ToolActorState<BashOptions>
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
  },

  lifecycle: onLifecycle({
    start: (_state, ctx) => {
      const slice = ctx.config as ToolsConfig | undefined
      const webSearchConfig = slice?.webSearch ?? null

      let webSearchRef: ActorRef<ToolInvokeMsg> | null = null

      if (webSearchConfig) {
        webSearchRef = ctx.spawn('web-search-0', createWebSearchActor(webSearchConfig), null) as ActorRef<ToolInvokeMsg>
        ctx.publishRetained(ToolRegistrationTopic, WEB_SEARCH_TOOL_NAME, { name: WEB_SEARCH_TOOL_NAME, schema: WEB_SEARCH_SCHEMA, ref: webSearchRef })
      }

      const bashConfig = slice?.bash ?? null
      const bashRef = ctx.spawn('bash-0', createBashActor(bashConfig ?? undefined), null) as ActorRef<ToolInvokeMsg>
      ctx.publishRetained(ToolRegistrationTopic, BASH_TOOL_NAME,  { name: BASH_TOOL_NAME,  schema: BASH_SCHEMA,  ref: bashRef })
      ctx.publishRetained(ToolRegistrationTopic, WRITE_TOOL_NAME, { name: WRITE_TOOL_NAME, schema: WRITE_SCHEMA, ref: bashRef })
      ctx.publishRetained(ToolRegistrationTopic, READ_TOOL_NAME,  { name: READ_TOOL_NAME,  schema: READ_SCHEMA,  ref: bashRef })

      ctx.log.info('tools plugin activated')
      return { state: {
        initialized: true,
        webSearch: { config: webSearchConfig, ref: webSearchRef, gen: 0 },
        bash:      { config: bashConfig, ref: bashRef, gen: 0 },
      } }
    },

    stopped: (state, ctx) => {
      if (state.webSearch.ref) {
        ctx.deleteRetained(ToolRegistrationTopic, WEB_SEARCH_TOOL_NAME, { name: WEB_SEARCH_TOOL_NAME, ref: null })
      }
      if (state.bash.ref) {
        ctx.deleteRetained(ToolRegistrationTopic, BASH_TOOL_NAME,  { name: BASH_TOOL_NAME,  ref: null })
        ctx.deleteRetained(ToolRegistrationTopic, WRITE_TOOL_NAME, { name: WRITE_TOOL_NAME, ref: null })
        ctx.deleteRetained(ToolRegistrationTopic, READ_TOOL_NAME,  { name: READ_TOOL_NAME,  ref: null })
      }
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
    config: (state, msg, ctx) => {
      if (state.webSearch.ref) {
        ctx.stop(state.webSearch.ref)
        ctx.deleteRetained(ToolRegistrationTopic, WEB_SEARCH_TOOL_NAME, { name: WEB_SEARCH_TOOL_NAME, ref: null })
      }
      if (state.bash.ref) {
        ctx.stop(state.bash.ref)
        ctx.deleteRetained(ToolRegistrationTopic, BASH_TOOL_NAME,  { name: BASH_TOOL_NAME,  ref: null })
        ctx.deleteRetained(ToolRegistrationTopic, WRITE_TOOL_NAME, { name: WRITE_TOOL_NAME, ref: null })
        ctx.deleteRetained(ToolRegistrationTopic, READ_TOOL_NAME,  { name: READ_TOOL_NAME,  ref: null })
      }

      const newWebSearchConfig = msg.slice?.webSearch ?? null
      const webSearchGen = state.webSearch.gen + 1
      const newBashConfig = msg.slice?.bash ?? null
      const bashGen = state.bash.gen + 1

      let webSearchRef: ActorRef<ToolInvokeMsg> | null = null

      if (newWebSearchConfig) {
        webSearchRef = ctx.spawn(`web-search-${webSearchGen}`, createWebSearchActor(newWebSearchConfig), null) as ActorRef<ToolInvokeMsg>
        ctx.publishRetained(ToolRegistrationTopic, WEB_SEARCH_TOOL_NAME, { name: WEB_SEARCH_TOOL_NAME, schema: WEB_SEARCH_SCHEMA, ref: webSearchRef })
      }

      const bashRef = ctx.spawn(`bash-${bashGen}`, createBashActor(newBashConfig ?? undefined), null) as ActorRef<ToolInvokeMsg>
      ctx.publishRetained(ToolRegistrationTopic, BASH_TOOL_NAME,  { name: BASH_TOOL_NAME,  schema: BASH_SCHEMA,  ref: bashRef })
      ctx.publishRetained(ToolRegistrationTopic, WRITE_TOOL_NAME, { name: WRITE_TOOL_NAME, schema: WRITE_SCHEMA, ref: bashRef })
      ctx.publishRetained(ToolRegistrationTopic, READ_TOOL_NAME,  { name: READ_TOOL_NAME,  schema: READ_SCHEMA,  ref: bashRef })

      return { state: {
        ...state,
        webSearch: { config: newWebSearchConfig, ref: webSearchRef, gen: webSearchGen },
        bash:      { config: newBashConfig, ref: bashRef, gen: bashGen },
      } }
    },
  }),
}

export default toolsPlugin
