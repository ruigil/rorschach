import { createWebSearchActor, type WebSearchActorOptions as WebSearchActorConfig, WEB_SEARCH_SCHEMA, WEB_SEARCH_TOOL_NAME } from './web-search.ts'
import { createBashActor, BASH_TOOL_NAME, BASH_SCHEMA, WRITE_TOOL_NAME, WRITE_SCHEMA, READ_TOOL_NAME, READ_SCHEMA } from './bash.ts'
import { createVisionActor, ANALYZE_IMAGE_TOOL_NAME, ANALYZE_IMAGE_SCHEMA, GENERATE_IMAGE_TOOL_NAME, GENERATE_IMAGE_SCHEMA } from './vision-actor.ts'
import { createCronActor, type CronState, CRON_CREATE_TOOL_NAME, CRON_CREATE_SCHEMA, CRON_DELETE_TOOL_NAME, CRON_DELETE_SCHEMA, CRON_LIST_TOOL_NAME, CRON_LIST_SCHEMA, CURRENT_TIME_TOOL_NAME, CURRENT_TIME_SCHEMA } from './cron.ts'
import { LlmProviderTopic } from '../../types/llm.ts'
import type { LlmProviderMsg } from '../../types/llm.ts'
import type { BashOptions as BashConfig } from 'just-bash'
import type { ActorRef, PluginActorState, PluginDef } from '../../system/types.ts'
import { onLifecycle, onMessage } from '../../system/match.ts'
import { redact } from '../../system/types.ts'
import type { ToolInvokeMsg } from '../../types/tools.ts'
import { ToolRegistrationTopic } from '../../types/tools.ts'

// ─── Config types ───

type VisionActorConfig = {
  model: string
}

export type ToolsConfig = {
  webSearch?: WebSearchActorConfig
  bash?: BashConfig
  visionActor?: VisionActorConfig
}

// ─── Plugin internals ───

type PluginMsg =
  | { type: 'config'; slice: ToolsConfig | undefined }
  | { type: '_llmProviderUpdated'; ref: ActorRef<LlmProviderMsg> | null }

type PluginState = {
  initialized: boolean
  webSearch: PluginActorState<WebSearchActorConfig>
  bash: PluginActorState<BashConfig>
  vision: PluginActorState<VisionActorConfig>
  cron: { ref: ActorRef<ToolInvokeMsg> | null }
  llmRef: ActorRef<LlmProviderMsg> | null
}


const toolsPlugin: PluginDef<PluginMsg, PluginState, ToolsConfig> = {
  id: 'tools',
  version: '1.0.0',
  description: 'Tool actors: web search, bash execution, and vision analysis',

  configDescriptor: {
    defaults: {
      webSearch: {
        apiKey: process.env.BRAVESEARCH_API_KEY ?? '',
        count: 20,
      },
      bash:{
        cwd: process.cwd(),
      },
    },
    onConfigChange: (config) => ({ type: 'config' as const, slice: config }),
  },

  initialState: {
    initialized: false,
    webSearch: { config: null, ref: null, gen: 0 },
    bash:      { config: null, ref: null, gen: 0 },
    vision:    { config: null, ref: null, gen: 0 },
    cron:      { ref: null },
    llmRef:    null,
  },

  lifecycle: onLifecycle({
    start: (_state, ctx) => {
      const slice = ctx.initialConfig() as ToolsConfig | undefined
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

      const cronRef = ctx.spawn('cron-0', createCronActor(), { jobs: {}, clientIds: new Set() } as CronState) as unknown as ActorRef<ToolInvokeMsg>
      ctx.publishRetained(ToolRegistrationTopic, CRON_CREATE_TOOL_NAME,   { name: CRON_CREATE_TOOL_NAME,   schema: CRON_CREATE_SCHEMA,   ref: cronRef })
      ctx.publishRetained(ToolRegistrationTopic, CRON_DELETE_TOOL_NAME,   { name: CRON_DELETE_TOOL_NAME,   schema: CRON_DELETE_SCHEMA,   ref: cronRef })
      ctx.publishRetained(ToolRegistrationTopic, CRON_LIST_TOOL_NAME,     { name: CRON_LIST_TOOL_NAME,     schema: CRON_LIST_SCHEMA,     ref: cronRef })
      ctx.publishRetained(ToolRegistrationTopic, CURRENT_TIME_TOOL_NAME,  { name: CURRENT_TIME_TOOL_NAME,  schema: CURRENT_TIME_SCHEMA,  ref: cronRef })

      // Subscribe to LLM provider — vision actor is spawned when the ref arrives
      ctx.subscribe(LlmProviderTopic, (event) => ({ type: '_llmProviderUpdated' as const, ref: event.ref }))

      ctx.log.info('tools plugin activated')
      return { state: {
        initialized: true,
        webSearch: { config: webSearchConfig, ref: webSearchRef, gen: 0 },
        bash:      { config: bashConfig, ref: bashRef, gen: 0 },
        vision:    { config: slice?.visionActor ?? null, ref: null, gen: 0 },
        cron:      { ref: cronRef },
        llmRef:    null,
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
      if (state.vision.ref) {
        ctx.deleteRetained(ToolRegistrationTopic, ANALYZE_IMAGE_TOOL_NAME,  { name: ANALYZE_IMAGE_TOOL_NAME,  ref: null })
        ctx.deleteRetained(ToolRegistrationTopic, GENERATE_IMAGE_TOOL_NAME, { name: GENERATE_IMAGE_TOOL_NAME, ref: null })
      }
      if (state.cron.ref) {
        ctx.deleteRetained(ToolRegistrationTopic, CRON_CREATE_TOOL_NAME,  { name: CRON_CREATE_TOOL_NAME,  ref: null })
        ctx.deleteRetained(ToolRegistrationTopic, CRON_DELETE_TOOL_NAME,  { name: CRON_DELETE_TOOL_NAME,  ref: null })
        ctx.deleteRetained(ToolRegistrationTopic, CRON_LIST_TOOL_NAME,    { name: CRON_LIST_TOOL_NAME,    ref: null })
        ctx.deleteRetained(ToolRegistrationTopic, CURRENT_TIME_TOOL_NAME, { name: CURRENT_TIME_TOOL_NAME, ref: null })
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
      if (state.vision.ref) {
        ctx.stop(state.vision.ref)
        ctx.deleteRetained(ToolRegistrationTopic, ANALYZE_IMAGE_TOOL_NAME,  { name: ANALYZE_IMAGE_TOOL_NAME,  ref: null })
        ctx.deleteRetained(ToolRegistrationTopic, GENERATE_IMAGE_TOOL_NAME, { name: GENERATE_IMAGE_TOOL_NAME, ref: null })
      }

      const newWebSearchConfig = msg.slice?.webSearch ?? null
      const webSearchGen = state.webSearch.gen + 1
      const newBashConfig = msg.slice?.bash ?? null
      const bashGen = state.bash.gen + 1
      const newVisionConfig = msg.slice?.visionActor ?? null
      const visionGen = state.vision.gen + 1

      let webSearchRef: ActorRef<ToolInvokeMsg> | null = null

      if (newWebSearchConfig) {
        webSearchRef = ctx.spawn(`web-search-${webSearchGen}`, createWebSearchActor(newWebSearchConfig), null) as ActorRef<ToolInvokeMsg>
        ctx.publishRetained(ToolRegistrationTopic, WEB_SEARCH_TOOL_NAME, { name: WEB_SEARCH_TOOL_NAME, schema: WEB_SEARCH_SCHEMA, ref: webSearchRef })
      }

      const bashRef = ctx.spawn(`bash-${bashGen}`, createBashActor(newBashConfig ?? undefined), null) as ActorRef<ToolInvokeMsg>
      ctx.publishRetained(ToolRegistrationTopic, BASH_TOOL_NAME,  { name: BASH_TOOL_NAME,  schema: BASH_SCHEMA,  ref: bashRef })
      ctx.publishRetained(ToolRegistrationTopic, WRITE_TOOL_NAME, { name: WRITE_TOOL_NAME, schema: WRITE_SCHEMA, ref: bashRef })
      ctx.publishRetained(ToolRegistrationTopic, READ_TOOL_NAME,  { name: READ_TOOL_NAME,  schema: READ_SCHEMA,  ref: bashRef })

      let visionRef: ActorRef<ToolInvokeMsg> | null = null
      if (state.llmRef && newVisionConfig) {
        const ref = ctx.spawn(`vision-actor-${visionGen}`, createVisionActor({ llmRef: state.llmRef, model: newVisionConfig.model }), { pending: {} })
        const visionRefTyped = ref as unknown as ActorRef<ToolInvokeMsg>
        ctx.publishRetained(ToolRegistrationTopic, ANALYZE_IMAGE_TOOL_NAME,  { name: ANALYZE_IMAGE_TOOL_NAME,  schema: ANALYZE_IMAGE_SCHEMA,  ref: visionRefTyped })
        ctx.publishRetained(ToolRegistrationTopic, GENERATE_IMAGE_TOOL_NAME, { name: GENERATE_IMAGE_TOOL_NAME, schema: GENERATE_IMAGE_SCHEMA, ref: visionRefTyped })
        visionRef = visionRefTyped
      }

      return { state: {
        ...state,
        webSearch: { config: newWebSearchConfig, ref: webSearchRef, gen: webSearchGen },
        bash:      { config: newBashConfig, ref: bashRef, gen: bashGen },
        vision:    { config: newVisionConfig, ref: visionRef, gen: visionGen },
      } }
    },

    _llmProviderUpdated: (state, msg, ctx) => {
      // Stop existing vision actor (llmRef changed or became null)
      if (state.vision.ref) {
        ctx.stop(state.vision.ref)
        ctx.deleteRetained(ToolRegistrationTopic, ANALYZE_IMAGE_TOOL_NAME,  { name: ANALYZE_IMAGE_TOOL_NAME,  ref: null })
        ctx.deleteRetained(ToolRegistrationTopic, GENERATE_IMAGE_TOOL_NAME, { name: GENERATE_IMAGE_TOOL_NAME, ref: null })
      }

      const visionGen = state.vision.gen + 1
      let visionRef: ActorRef<ToolInvokeMsg> | null = null

      if (msg.ref && state.vision.config) {
        const ref = ctx.spawn(`vision-actor-${visionGen}`, createVisionActor({ llmRef: msg.ref, model: state.vision.config.model }), { pending: {} })
        const visionRefTyped = ref as unknown as ActorRef<ToolInvokeMsg>
        ctx.publishRetained(ToolRegistrationTopic, ANALYZE_IMAGE_TOOL_NAME,  { name: ANALYZE_IMAGE_TOOL_NAME,  schema: ANALYZE_IMAGE_SCHEMA,  ref: visionRefTyped })
        ctx.publishRetained(ToolRegistrationTopic, GENERATE_IMAGE_TOOL_NAME, { name: GENERATE_IMAGE_TOOL_NAME, schema: GENERATE_IMAGE_SCHEMA, ref: visionRefTyped })
        visionRef = visionRefTyped
      }

      return { state: {
        ...state,
        llmRef: msg.ref,
        vision: { ...state.vision, ref: visionRef, gen: visionGen },
      } }
    },
  }),
}

export default toolsPlugin
