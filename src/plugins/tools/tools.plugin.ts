import { createWebSearchActor, type WebSearchActorOptions as WebSearchActorConfig, WEB_SEARCH_SCHEMA, WEB_SEARCH_TOOL_NAME } from './web-search.ts'
import { createBashActor, BASH_TOOL_NAME, BASH_SCHEMA, WRITE_TOOL_NAME, WRITE_SCHEMA, READ_TOOL_NAME, READ_SCHEMA } from './bash.ts'
import { createVisionActor, ANALYZE_IMAGE_TOOL_NAME, ANALYZE_IMAGE_SCHEMA, GENERATE_IMAGE_TOOL_NAME, GENERATE_IMAGE_SCHEMA } from './vision-actor.ts'
import { createCronActor, type CronState, CRON_CREATE_TOOL_NAME, CRON_CREATE_SCHEMA, CRON_DELETE_TOOL_NAME, CRON_DELETE_SCHEMA, CRON_LIST_TOOL_NAME, CRON_LIST_SCHEMA } from './cron.ts'
import { createAudioActor, type AudioState, TRANSCRIBE_AUDIO_TOOL_NAME, TRANSCRIBE_AUDIO_SCHEMA, TEXT_TO_SPEECH_TOOL_NAME, TEXT_TO_SPEECH_SCHEMA } from './audio.ts'
import { createPdfActor, PDF_TOOL_NAME, PDF_SCHEMA } from './pdf.ts'
import { createFetchFileActor, FETCH_FILE_TOOL_NAME, FETCH_FILE_SCHEMA } from './fetch-file.ts'
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

type AudioActorConfig = {
  model: string
  voice?: string
}

export type ToolsConfig = {
  webSearch?: WebSearchActorConfig
  bash?: BashConfig
  visionActor?: VisionActorConfig
  audioActor?: AudioActorConfig
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
  audio: PluginActorState<AudioActorConfig>
  cron: { ref: ActorRef<ToolInvokeMsg> | null }
  pdf: { ref: ActorRef<ToolInvokeMsg> | null }
  fetchFile: { ref: ActorRef<ToolInvokeMsg> | null }
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
    audio:     { config: null, ref: null, gen: 0 },
    cron:      { ref: null },
    pdf:       { ref: null },
    fetchFile: { ref: null },
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

      const pdfRef = ctx.spawn('pdf-0', createPdfActor(), null) as ActorRef<ToolInvokeMsg>
      ctx.publishRetained(ToolRegistrationTopic, PDF_TOOL_NAME, { name: PDF_TOOL_NAME, schema: PDF_SCHEMA, ref: pdfRef })

      const fetchFileRef = ctx.spawn('fetch-file-0', createFetchFileActor(), null) as ActorRef<ToolInvokeMsg>
      ctx.publishRetained(ToolRegistrationTopic, FETCH_FILE_TOOL_NAME, { name: FETCH_FILE_TOOL_NAME, schema: FETCH_FILE_SCHEMA, ref: fetchFileRef })

      // Subscribe to LLM provider — vision and audio actors are spawned when the ref arrives
      ctx.subscribe(LlmProviderTopic, (event) => ({ type: '_llmProviderUpdated' as const, ref: event.ref }))

      ctx.log.info('tools plugin activated')
      return { state: {
        initialized: true,
        webSearch: { config: webSearchConfig, ref: webSearchRef, gen: 0 },
        bash:      { config: bashConfig, ref: bashRef, gen: 0 },
        vision:    { config: slice?.visionActor ?? null, ref: null, gen: 0 },
        audio:     { config: slice?.audioActor ?? null, ref: null, gen: 0 },
        cron:      { ref: cronRef },
        pdf:       { ref: pdfRef },
        fetchFile: { ref: fetchFileRef },
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
      if (state.audio.ref) {
        ctx.deleteRetained(ToolRegistrationTopic, TRANSCRIBE_AUDIO_TOOL_NAME, { name: TRANSCRIBE_AUDIO_TOOL_NAME, ref: null })
        ctx.deleteRetained(ToolRegistrationTopic, TEXT_TO_SPEECH_TOOL_NAME,   { name: TEXT_TO_SPEECH_TOOL_NAME,   ref: null })
      }
      if (state.cron.ref) {
        ctx.deleteRetained(ToolRegistrationTopic, CRON_CREATE_TOOL_NAME,  { name: CRON_CREATE_TOOL_NAME,  ref: null })
        ctx.deleteRetained(ToolRegistrationTopic, CRON_DELETE_TOOL_NAME,  { name: CRON_DELETE_TOOL_NAME,  ref: null })
        ctx.deleteRetained(ToolRegistrationTopic, CRON_LIST_TOOL_NAME,    { name: CRON_LIST_TOOL_NAME,    ref: null })
      }
      if (state.pdf.ref) {
        ctx.deleteRetained(ToolRegistrationTopic, PDF_TOOL_NAME, { name: PDF_TOOL_NAME, ref: null })
      }
      if (state.fetchFile.ref) {
        ctx.deleteRetained(ToolRegistrationTopic, FETCH_FILE_TOOL_NAME, { name: FETCH_FILE_TOOL_NAME, ref: null })
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
      if (state.audio.ref) {
        ctx.stop(state.audio.ref)
        ctx.deleteRetained(ToolRegistrationTopic, TRANSCRIBE_AUDIO_TOOL_NAME, { name: TRANSCRIBE_AUDIO_TOOL_NAME, ref: null })
        ctx.deleteRetained(ToolRegistrationTopic, TEXT_TO_SPEECH_TOOL_NAME,   { name: TEXT_TO_SPEECH_TOOL_NAME,   ref: null })
      }
      if (state.pdf.ref) {
        ctx.stop(state.pdf.ref)
        ctx.deleteRetained(ToolRegistrationTopic, PDF_TOOL_NAME, { name: PDF_TOOL_NAME, ref: null })
      }
      if (state.fetchFile.ref) {
        ctx.stop(state.fetchFile.ref)
        ctx.deleteRetained(ToolRegistrationTopic, FETCH_FILE_TOOL_NAME, { name: FETCH_FILE_TOOL_NAME, ref: null })
      }

      const newWebSearchConfig = msg.slice?.webSearch ?? null
      const webSearchGen = state.webSearch.gen + 1
      const newBashConfig = msg.slice?.bash ?? null
      const bashGen = state.bash.gen + 1
      const newVisionConfig = msg.slice?.visionActor ?? null
      const visionGen = state.vision.gen + 1
      const newAudioConfig = msg.slice?.audioActor ?? null
      const audioGen = state.audio.gen + 1

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

      let audioRef: ActorRef<ToolInvokeMsg> | null = null
      if (state.llmRef && newAudioConfig) {
        const ref = ctx.spawn(`audio-actor-${audioGen}`, createAudioActor({ llmRef: state.llmRef, model: newAudioConfig.model, voice: newAudioConfig.voice ?? 'alloy' }), { pending: {} } as AudioState)
        const audioRefTyped = ref as unknown as ActorRef<ToolInvokeMsg>
        ctx.publishRetained(ToolRegistrationTopic, TRANSCRIBE_AUDIO_TOOL_NAME, { name: TRANSCRIBE_AUDIO_TOOL_NAME, schema: TRANSCRIBE_AUDIO_SCHEMA, ref: audioRefTyped })
        ctx.publishRetained(ToolRegistrationTopic, TEXT_TO_SPEECH_TOOL_NAME,   { name: TEXT_TO_SPEECH_TOOL_NAME,   schema: TEXT_TO_SPEECH_SCHEMA,   ref: audioRefTyped })
        audioRef = audioRefTyped
      }

      const pdfGen = (state.pdf.ref ? 1 : 0) + 1
      const newPdfRef = ctx.spawn(`pdf-${pdfGen}`, createPdfActor(), null) as ActorRef<ToolInvokeMsg>
      ctx.publishRetained(ToolRegistrationTopic, PDF_TOOL_NAME, { name: PDF_TOOL_NAME, schema: PDF_SCHEMA, ref: newPdfRef })

      const fetchFileGen = (state.fetchFile.ref ? 1 : 0) + 1
      const newFetchFileRef = ctx.spawn(`fetch-file-${fetchFileGen}`, createFetchFileActor(), null) as ActorRef<ToolInvokeMsg>
      ctx.publishRetained(ToolRegistrationTopic, FETCH_FILE_TOOL_NAME, { name: FETCH_FILE_TOOL_NAME, schema: FETCH_FILE_SCHEMA, ref: newFetchFileRef })

      return { state: {
        ...state,
        webSearch: { config: newWebSearchConfig, ref: webSearchRef, gen: webSearchGen },
        bash:      { config: newBashConfig, ref: bashRef, gen: bashGen },
        vision:    { config: newVisionConfig, ref: visionRef, gen: visionGen },
        audio:     { config: newAudioConfig,  ref: audioRef,  gen: audioGen  },
        pdf:       { ref: newPdfRef },
        fetchFile: { ref: newFetchFileRef },
      } }
    },

    _llmProviderUpdated: (state, msg, ctx) => {
      // Stop existing vision actor (llmRef changed or became null)
      if (state.vision.ref) {
        ctx.stop(state.vision.ref)
        ctx.deleteRetained(ToolRegistrationTopic, ANALYZE_IMAGE_TOOL_NAME,  { name: ANALYZE_IMAGE_TOOL_NAME,  ref: null })
        ctx.deleteRetained(ToolRegistrationTopic, GENERATE_IMAGE_TOOL_NAME, { name: GENERATE_IMAGE_TOOL_NAME, ref: null })
      }

      // Stop existing audio actor
      if (state.audio.ref) {
        ctx.stop(state.audio.ref)
        ctx.deleteRetained(ToolRegistrationTopic, TRANSCRIBE_AUDIO_TOOL_NAME, { name: TRANSCRIBE_AUDIO_TOOL_NAME, ref: null })
        ctx.deleteRetained(ToolRegistrationTopic, TEXT_TO_SPEECH_TOOL_NAME,   { name: TEXT_TO_SPEECH_TOOL_NAME,   ref: null })
      }

      const visionGen = state.vision.gen
      let visionRef: ActorRef<ToolInvokeMsg> | null = null

      if (msg.ref && state.vision.config) {
        const ref = ctx.spawn(`vision-actor-${visionGen}`, createVisionActor({ llmRef: msg.ref, model: state.vision.config.model }), { pending: {} })
        const visionRefTyped = ref as unknown as ActorRef<ToolInvokeMsg>
        ctx.publishRetained(ToolRegistrationTopic, ANALYZE_IMAGE_TOOL_NAME,  { name: ANALYZE_IMAGE_TOOL_NAME,  schema: ANALYZE_IMAGE_SCHEMA,  ref: visionRefTyped })
        ctx.publishRetained(ToolRegistrationTopic, GENERATE_IMAGE_TOOL_NAME, { name: GENERATE_IMAGE_TOOL_NAME, schema: GENERATE_IMAGE_SCHEMA, ref: visionRefTyped })
        visionRef = visionRefTyped
      }

      const audioGen = state.audio.gen
      let audioRef: ActorRef<ToolInvokeMsg> | null = null

      if (msg.ref && state.audio.config) {
        const ref = ctx.spawn(`audio-actor-${audioGen}`, createAudioActor({ llmRef: msg.ref, model: state.audio.config.model, voice: state.audio.config.voice ?? 'alloy' }), { pending: {} } as AudioState)
        const audioRefTyped = ref as unknown as ActorRef<ToolInvokeMsg>
        ctx.publishRetained(ToolRegistrationTopic, TRANSCRIBE_AUDIO_TOOL_NAME, { name: TRANSCRIBE_AUDIO_TOOL_NAME, schema: TRANSCRIBE_AUDIO_SCHEMA, ref: audioRefTyped })
        ctx.publishRetained(ToolRegistrationTopic, TEXT_TO_SPEECH_TOOL_NAME,   { name: TEXT_TO_SPEECH_TOOL_NAME,   schema: TEXT_TO_SPEECH_SCHEMA,   ref: audioRefTyped })
        audioRef = audioRefTyped
      }

      return { state: {
        ...state,
        llmRef: msg.ref,
        vision: { ...state.vision, ref: visionRef, gen: visionGen + 1 },
        audio:  { ...state.audio,  ref: audioRef,  gen: audioGen  + 1 },
      } }
    },
  }),
}

export default toolsPlugin
