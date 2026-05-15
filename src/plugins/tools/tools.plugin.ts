import { WebSearch, type WebSearchActorOptions as WebSearchActorConfig, webSearchTool } from './web-search.ts'
import { JustBash, bashTool, writeTool, readTool } from './bash.ts'
import { Vision, analyzeImageTool, generateImageTool } from './vision-actor.ts'
import { Cron, cronCreateTool, cronDeleteTool, cronListTool } from './cron.ts'
import { Audio, transcribeAudioTool, textToSpeechTool } from './audio.ts'
import { Video, generateVideoTool } from './video-actor.ts'
import { PDF, pdfTool } from './pdf.ts'
import { FetchFile, fetchFileTool } from './fetch-file.ts'
import { ToolStatus, toolStatusTool } from './tool-status.ts'
import { LlmProviderTopic } from '../../types/llm.ts'
import type { LlmProviderMsg } from '../../types/llm.ts'
import type { BashOptions as BashConfig } from 'just-bash'
import { defineConfig, createSlot, stopSlot, type ActorSlot } from '../../system/config.ts'
import type { ActorRef, PluginDef } from '../../system/types.ts'
import { onLifecycle, onMessage } from '../../system/match.ts'
import { redact } from '../../system/types.ts'
import type { ToolMsg } from '../../types/tools.ts'
import { ToolRegistrationTopic } from '../../types/tools.ts'
import { ConfigSchemaTopic } from '../../types/config.ts'
import { RouteRegistrationTopic } from '../../types/routes.ts'
import { toolsSchemas, buildToolsConfigRoute } from './routes.ts'

// ─── Config types ───

type VisionActorConfig = {
  model: string
}

type AudioActorConfig = {
  ttsModel: string
  sttModel: string
  voice?: string
}

type VideoActorConfig = {
  model: string
  aspectRatio?: string
  duration?: number
  resolution?: string
  pollIntervalMs?: number
  pollTimeoutMs?: number
}

export type ToolsConfig = {
  webSearch?: WebSearchActorConfig
  bash?: BashConfig
  visionActor?: VisionActorConfig
  audioActor?: AudioActorConfig
  videoActor?: VideoActorConfig
}

const config = defineConfig<ToolsConfig>('tools', {
  webSearch: {
    apiKey: process.env.BRAVESEARCH_API_KEY ?? '',
    count: 20,
  },
  bash: {
    cwd: process.cwd(),
  },
})

// ─── Plugin internals ───

type PluginMsg =
  | { type: 'config'; slice: ToolsConfig | undefined }
  | { type: '_llmProviderUpdated'; ref: ActorRef<LlmProviderMsg> | null }

type PluginState = {
  initialized: boolean
  webSearch: ActorSlot<WebSearchActorConfig>
  bash:      ActorSlot<BashConfig>
  vision:    ActorSlot<VisionActorConfig>
  audio:     ActorSlot<AudioActorConfig>
  video:     ActorSlot<VideoActorConfig>
  cron:      ActorSlot<never>
  pdf:       ActorSlot<never>
  fetchFile: ActorSlot<never>
  toolStatus: ActorSlot<never>
  llmRef: ActorRef<LlmProviderMsg> | null
}


const toolsPlugin: PluginDef<PluginMsg, PluginState, ToolsConfig> = {
  id: 'tools',
  version: '1.0.0',
  description: 'Tool actors: web search, bash execution, and vision analysis',

  configDescriptor: config,

  initialState: {
    initialized: false,
    webSearch:  createSlot(),
    bash:       createSlot(),
    vision:     createSlot(),
    audio:      createSlot(),
    video:      createSlot(),
    cron:       createSlot(),
    pdf:        createSlot(),
    fetchFile:  createSlot(),
    toolStatus: createSlot(),
    llmRef:     null,
  },

  lifecycle: onLifecycle({
    start: (_state, ctx) => {
      const slice = ctx.initialConfig() as ToolsConfig | undefined

      // Publish config schemas and config route
      for (const section of toolsSchemas) {
        ctx.publishRetained(ConfigSchemaTopic, section.id, section)
      }
      for (const reg of buildToolsConfigRoute(() => slice)) {
        ctx.publishRetained(RouteRegistrationTopic, reg.id, reg)
      }

      const webSearchConfig = slice?.webSearch ?? null

      let webSearchRef: ActorRef<ToolMsg> | null = null

      if (webSearchConfig) {
        webSearchRef = ctx.spawn('web-search-0', WebSearch(webSearchConfig)) as ActorRef<ToolMsg>
        ctx.publishRetained(ToolRegistrationTopic, webSearchTool.name, { ...webSearchTool, ref: webSearchRef })
      }

      const bashConfig = slice?.bash ?? null
      const bashRef = ctx.spawn('bash-0', JustBash(bashConfig ?? undefined)) as ActorRef<ToolMsg>
      ctx.publishRetained(ToolRegistrationTopic, bashTool.name,  { ...bashTool,  ref: bashRef })
      ctx.publishRetained(ToolRegistrationTopic, writeTool.name, { ...writeTool, ref: bashRef })
      ctx.publishRetained(ToolRegistrationTopic, readTool.name,  { ...readTool,  ref: bashRef })

      const cronRef = ctx.spawn('cron-0', Cron()) as unknown as ActorRef<ToolMsg>
      ctx.publishRetained(ToolRegistrationTopic, cronCreateTool.name, { ...cronCreateTool, ref: cronRef })
      ctx.publishRetained(ToolRegistrationTopic, cronDeleteTool.name, { ...cronDeleteTool, ref: cronRef })
      ctx.publishRetained(ToolRegistrationTopic, cronListTool.name,   { ...cronListTool,   ref: cronRef })

      const pdfRef = ctx.spawn('pdf-0', PDF()) as ActorRef<ToolMsg>
      ctx.publishRetained(ToolRegistrationTopic, pdfTool.name, { ...pdfTool, ref: pdfRef })

      const fetchFileRef = ctx.spawn('fetch-file-0', FetchFile()) as ActorRef<ToolMsg>
      ctx.publishRetained(ToolRegistrationTopic, fetchFileTool.name, { ...fetchFileTool, ref: fetchFileRef })

      const toolStatusRef = ctx.spawn('tool-status-0', ToolStatus()) as unknown as ActorRef<ToolMsg>
      ctx.publishRetained(ToolRegistrationTopic, toolStatusTool.name, { ...toolStatusTool, ref: toolStatusRef })

      // Subscribe to LLM provider — vision and audio actors are spawned when the ref arrives
      ctx.subscribe(LlmProviderTopic, (event) => ({ type: '_llmProviderUpdated' as const, ref: event.ref }))

      ctx.log.info('tools plugin activated')
      return { state: {
        initialized: true,
        webSearch:  { config: webSearchConfig, ref: webSearchRef,  gen: 0 },
        bash:       { config: bashConfig,      ref: bashRef,       gen: 0 },
        vision:     { config: slice?.visionActor ?? null, ref: null, gen: 0 },
        audio:      { config: slice?.audioActor ?? null,  ref: null, gen: 0 },
        video:      { config: slice?.videoActor ?? null,  ref: null, gen: 0 },
        cron:       { config: null, ref: cronRef,       gen: 0 },
        pdf:        { config: null, ref: pdfRef,        gen: 0 },
        fetchFile:  { config: null, ref: fetchFileRef,  gen: 0 },
        toolStatus: { config: null, ref: toolStatusRef, gen: 0 },
        llmRef:     null,
      } }
    },

    stopped: (state, ctx) => {
      if (state.webSearch.ref) {
        ctx.deleteRetained(ToolRegistrationTopic, webSearchTool.name, { name: webSearchTool.name, ref: null })
      }
      if (state.bash.ref) {
        ctx.deleteRetained(ToolRegistrationTopic, bashTool.name,  { name: bashTool.name,  ref: null })
        ctx.deleteRetained(ToolRegistrationTopic, writeTool.name, { name: writeTool.name, ref: null })
        ctx.deleteRetained(ToolRegistrationTopic, readTool.name,  { name: readTool.name,  ref: null })
      }
      if (state.vision.ref) {
        ctx.deleteRetained(ToolRegistrationTopic, analyzeImageTool.name,  { name: analyzeImageTool.name,  ref: null })
        ctx.deleteRetained(ToolRegistrationTopic, generateImageTool.name, { name: generateImageTool.name, ref: null })
      }
      if (state.audio.ref) {
        ctx.deleteRetained(ToolRegistrationTopic, transcribeAudioTool.name, { name: transcribeAudioTool.name, ref: null })
        ctx.deleteRetained(ToolRegistrationTopic, textToSpeechTool.name,   { name: textToSpeechTool.name,   ref: null })
      }
      if (state.video.ref) {
        ctx.deleteRetained(ToolRegistrationTopic, generateVideoTool.name, { name: generateVideoTool.name, ref: null })
      }
      if (state.cron.ref) {
        ctx.deleteRetained(ToolRegistrationTopic, cronCreateTool.name, { name: cronCreateTool.name, ref: null })
        ctx.deleteRetained(ToolRegistrationTopic, cronDeleteTool.name, { name: cronDeleteTool.name, ref: null })
        ctx.deleteRetained(ToolRegistrationTopic, cronListTool.name,   { name: cronListTool.name,   ref: null })
      }
      if (state.pdf.ref) {
        ctx.deleteRetained(ToolRegistrationTopic, pdfTool.name, { name: pdfTool.name, ref: null })
      }
      if (state.fetchFile.ref) {
        ctx.deleteRetained(ToolRegistrationTopic, fetchFileTool.name, { name: fetchFileTool.name, ref: null })
      }
      if (state.toolStatus.ref) {
        ctx.deleteRetained(ToolRegistrationTopic, toolStatusTool.name, { name: toolStatusTool.name, ref: null })
      }

      stopSlot(ctx, state.webSearch)
      stopSlot(ctx, state.bash)
      stopSlot(ctx, state.vision)
      stopSlot(ctx, state.audio)
      stopSlot(ctx, state.video)
      stopSlot(ctx, state.cron)
      stopSlot(ctx, state.pdf)
      stopSlot(ctx, state.fetchFile)
      stopSlot(ctx, state.toolStatus)

      // Tombstone config schemas and config route
      for (const section of toolsSchemas) {
        ctx.deleteRetained(ConfigSchemaTopic, section.id, { ...section, schema: null })
      }
      for (const reg of buildToolsConfigRoute(() => undefined)) {
        ctx.deleteRetained(RouteRegistrationTopic, reg.id, { id: reg.id, method: reg.method, path: reg.path, handler: null })
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
      // Unregister all tools
      if (state.webSearch.ref) {
        ctx.deleteRetained(ToolRegistrationTopic, webSearchTool.name, { name: webSearchTool.name, ref: null })
      }
      if (state.bash.ref) {
        ctx.deleteRetained(ToolRegistrationTopic, bashTool.name,  { name: bashTool.name,  ref: null })
        ctx.deleteRetained(ToolRegistrationTopic, writeTool.name, { name: writeTool.name, ref: null })
        ctx.deleteRetained(ToolRegistrationTopic, readTool.name,  { name: readTool.name,  ref: null })
      }
      if (state.vision.ref) {
        ctx.deleteRetained(ToolRegistrationTopic, analyzeImageTool.name,  { name: analyzeImageTool.name,  ref: null })
        ctx.deleteRetained(ToolRegistrationTopic, generateImageTool.name, { name: generateImageTool.name, ref: null })
      }
      if (state.audio.ref) {
        ctx.deleteRetained(ToolRegistrationTopic, transcribeAudioTool.name, { name: transcribeAudioTool.name, ref: null })
        ctx.deleteRetained(ToolRegistrationTopic, textToSpeechTool.name,   { name: textToSpeechTool.name,   ref: null })
      }
      if (state.video.ref) {
        ctx.deleteRetained(ToolRegistrationTopic, generateVideoTool.name, { name: generateVideoTool.name, ref: null })
      }
      if (state.cron.ref) {
        ctx.deleteRetained(ToolRegistrationTopic, cronCreateTool.name, { name: cronCreateTool.name, ref: null })
        ctx.deleteRetained(ToolRegistrationTopic, cronDeleteTool.name, { name: cronDeleteTool.name, ref: null })
        ctx.deleteRetained(ToolRegistrationTopic, cronListTool.name,   { name: cronListTool.name,   ref: null })
      }
      if (state.pdf.ref) {
        ctx.deleteRetained(ToolRegistrationTopic, pdfTool.name, { name: pdfTool.name, ref: null })
      }
      if (state.fetchFile.ref) {
        ctx.deleteRetained(ToolRegistrationTopic, fetchFileTool.name, { name: fetchFileTool.name, ref: null })
      }

      // Stop all actors
      stopSlot(ctx, state.webSearch)
      stopSlot(ctx, state.bash)
      stopSlot(ctx, state.vision)
      stopSlot(ctx, state.audio)
      stopSlot(ctx, state.video)
      stopSlot(ctx, state.cron)
      stopSlot(ctx, state.pdf)
      stopSlot(ctx, state.fetchFile)

      const newWebSearchConfig = msg.slice?.webSearch ?? null
      const newBashConfig = msg.slice?.bash ?? null
      const newVisionConfig = msg.slice?.visionActor ?? null
      const newAudioConfig = msg.slice?.audioActor ?? null
      const newVideoConfig = msg.slice?.videoActor ?? null

      let webSearchRef: ActorRef<ToolMsg> | null = null
      if (newWebSearchConfig) {
        webSearchRef = ctx.spawn(`web-search-${state.webSearch.gen + 1}`, WebSearch(newWebSearchConfig)) as ActorRef<ToolMsg>
        ctx.publishRetained(ToolRegistrationTopic, webSearchTool.name, { ...webSearchTool, ref: webSearchRef })
      }

      const bashRef = ctx.spawn(`bash-${state.bash.gen + 1}`, JustBash(newBashConfig ?? undefined)) as ActorRef<ToolMsg>
      ctx.publishRetained(ToolRegistrationTopic, bashTool.name,  { ...bashTool,  ref: bashRef })
      ctx.publishRetained(ToolRegistrationTopic, writeTool.name, { ...writeTool, ref: bashRef })
      ctx.publishRetained(ToolRegistrationTopic, readTool.name,  { ...readTool,  ref: bashRef })

      let visionRef: ActorRef<ToolMsg> | null = null
      if (state.llmRef && newVisionConfig) {
        const ref = ctx.spawn(`vision-actor-${state.vision.gen + 1}`, Vision({ llmRef: state.llmRef, model: newVisionConfig.model }))
        visionRef = ref as unknown as ActorRef<ToolMsg>
        ctx.publishRetained(ToolRegistrationTopic, analyzeImageTool.name,  { ...analyzeImageTool,  ref: visionRef })
        ctx.publishRetained(ToolRegistrationTopic, generateImageTool.name, { ...generateImageTool, ref: visionRef })
      }

      let audioRef: ActorRef<ToolMsg> | null = null
      if (state.llmRef && newAudioConfig) {
        const ref = ctx.spawn(`audio-actor-${state.audio.gen + 1}`, Audio({ llmRef: state.llmRef, ttsModel: newAudioConfig.ttsModel, sttModel: newAudioConfig.sttModel, voice: newAudioConfig.voice ?? 'alloy' }))
        audioRef = ref as unknown as ActorRef<ToolMsg>
        ctx.publishRetained(ToolRegistrationTopic, transcribeAudioTool.name, { ...transcribeAudioTool, ref: audioRef })
        ctx.publishRetained(ToolRegistrationTopic, textToSpeechTool.name,   { ...textToSpeechTool,   ref: audioRef })
      }

      let videoRef: ActorRef<ToolMsg> | null = null
      if (state.llmRef && newVideoConfig) {
        const ref = ctx.spawn(`video-actor-${state.video.gen + 1}`, Video({ llmRef: state.llmRef, model: newVideoConfig.model, aspectRatio: newVideoConfig.aspectRatio, duration: newVideoConfig.duration, resolution: newVideoConfig.resolution, pollIntervalMs: newVideoConfig.pollIntervalMs, pollTimeoutMs: newVideoConfig.pollTimeoutMs }))
        videoRef = ref as unknown as ActorRef<ToolMsg>
        ctx.publishRetained(ToolRegistrationTopic, generateVideoTool.name, { ...generateVideoTool, ref: videoRef, mayBeLongRunning: true })
      }

      const cronRef = ctx.spawn(`cron-${state.cron.gen + 1}`, Cron()) as unknown as ActorRef<ToolMsg>
      ctx.publishRetained(ToolRegistrationTopic, cronCreateTool.name, { ...cronCreateTool, ref: cronRef })
      ctx.publishRetained(ToolRegistrationTopic, cronDeleteTool.name, { ...cronDeleteTool, ref: cronRef })
      ctx.publishRetained(ToolRegistrationTopic, cronListTool.name,   { ...cronListTool,   ref: cronRef })

      const pdfRef = ctx.spawn(`pdf-${state.pdf.gen + 1}`, PDF()) as ActorRef<ToolMsg>
      ctx.publishRetained(ToolRegistrationTopic, pdfTool.name, { ...pdfTool, ref: pdfRef })

      const fetchFileRef = ctx.spawn(`fetch-file-${state.fetchFile.gen + 1}`, FetchFile()) as ActorRef<ToolMsg>
      ctx.publishRetained(ToolRegistrationTopic, fetchFileTool.name, { ...fetchFileTool, ref: fetchFileRef })

      return { state: {
        ...state,
        webSearch: { config: newWebSearchConfig, ref: webSearchRef, gen: state.webSearch.gen + 1 },
        bash:      { config: newBashConfig,      ref: bashRef,      gen: state.bash.gen + 1 },
        vision:    { config: newVisionConfig,    ref: visionRef,    gen: state.vision.gen + 1 },
        audio:     { config: newAudioConfig,     ref: audioRef,     gen: state.audio.gen + 1 },
        video:     { config: newVideoConfig,     ref: videoRef,     gen: state.video.gen + 1 },
        cron:      { config: null, ref: cronRef,      gen: state.cron.gen + 1 },
        pdf:       { config: null, ref: pdfRef,       gen: state.pdf.gen + 1 },
        fetchFile: { config: null, ref: fetchFileRef, gen: state.fetchFile.gen + 1 },
      } }
    },

    _llmProviderUpdated: (state, msg, ctx) => {
      // Stop existing vision actor (llmRef changed or became null)
      if (state.vision.ref) {
        ctx.stop(state.vision.ref)
        ctx.deleteRetained(ToolRegistrationTopic, analyzeImageTool.name,  { name: analyzeImageTool.name,  ref: null })
        ctx.deleteRetained(ToolRegistrationTopic, generateImageTool.name, { name: generateImageTool.name, ref: null })
      }

      // Stop existing audio actor
      if (state.audio.ref) {
        ctx.stop(state.audio.ref)
        ctx.deleteRetained(ToolRegistrationTopic, transcribeAudioTool.name, { name: transcribeAudioTool.name, ref: null })
        ctx.deleteRetained(ToolRegistrationTopic, textToSpeechTool.name,   { name: textToSpeechTool.name,   ref: null })
      }

      // Stop existing video actor
      if (state.video.ref) {
        ctx.stop(state.video.ref)
        ctx.deleteRetained(ToolRegistrationTopic, generateVideoTool.name, { name: generateVideoTool.name, ref: null })
      }

      const visionGen = state.vision.gen
      let visionRef: ActorRef<ToolMsg> | null = null

      if (msg.ref && state.vision.config) {
        const ref = ctx.spawn(`vision-actor-${visionGen}`, Vision({ llmRef: msg.ref, model: state.vision.config.model }))
        visionRef = ref as unknown as ActorRef<ToolMsg>
        ctx.publishRetained(ToolRegistrationTopic, analyzeImageTool.name,  { ...analyzeImageTool,  ref: visionRef })
        ctx.publishRetained(ToolRegistrationTopic, generateImageTool.name, { ...generateImageTool, ref: visionRef })
      }

      const audioGen = state.audio.gen
      let audioRef: ActorRef<ToolMsg> | null = null

      if (msg.ref && state.audio.config) {
        const ref = ctx.spawn(`audio-actor-${audioGen}`, Audio({ llmRef: msg.ref, ttsModel: state.audio.config.ttsModel, sttModel: state.audio.config.sttModel, voice: state.audio.config.voice ?? 'alloy' }))
        audioRef = ref as unknown as ActorRef<ToolMsg>
        ctx.publishRetained(ToolRegistrationTopic, transcribeAudioTool.name, { ...transcribeAudioTool, ref: audioRef })
        ctx.publishRetained(ToolRegistrationTopic, textToSpeechTool.name,   { ...textToSpeechTool,   ref: audioRef })
      }

      const videoGen = state.video.gen
      let videoRef: ActorRef<ToolMsg> | null = null

      if (msg.ref && state.video.config) {
        const ref = ctx.spawn(`video-actor-${videoGen}`, Video({ llmRef: msg.ref, model: state.video.config.model, aspectRatio: state.video.config.aspectRatio, duration: state.video.config.duration, resolution: state.video.config.resolution, pollIntervalMs: state.video.config.pollIntervalMs, pollTimeoutMs: state.video.config.pollTimeoutMs }))
        videoRef = ref as unknown as ActorRef<ToolMsg>
        ctx.publishRetained(ToolRegistrationTopic, generateVideoTool.name, { ...generateVideoTool, ref: videoRef, mayBeLongRunning: true })
      }

      return { state: {
        ...state,
        llmRef: msg.ref,
        vision: { ...state.vision, ref: visionRef, gen: visionGen + 1 },
        audio:  { ...state.audio,  ref: audioRef,  gen: audioGen  + 1 },
        video:  { ...state.video,  ref: videoRef,  gen: videoGen  + 1 },
      } }
    },
  }),
}

export default toolsPlugin
