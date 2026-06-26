import { createPluginFactory } from '../../system/index.ts'
import { WebSearch, type WebSearchActorOptions as WebSearchActorConfig, webSearchTool } from './web-search.ts'
import { BashTool, bashTool, writeTool, readTool, editTool } from './bash.ts'
import { Vision, analyzeImageTool, generateImageTool } from './vision-actor.ts'
import { Cron, cronCreateTool, cronDeleteTool, cronListTool } from './cron.ts'
import { Audio, transcribeAudioTool, textToSpeechTool } from './audio.ts'
import { Video, generateVideoTool } from './video-actor.ts'
import { PDF, pdfTool } from './pdf.ts'
import { FetchFile, fetchFileTool } from './fetch-file.ts'
import { ToolStatus, toolStatusTool } from './tool-status.ts'
import type { BashOptions as BashConfig } from 'just-bash'
import { defineConfig } from '../../system/index.ts'
import { toolsSchemas } from './routes.ts'

type VisionConfig = {
  model: string
}

type AudioConfig = {
  ttsModel: string
  sttModel: string
  voice?: string
}

type VideoConfig = {
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
  vision?: VisionConfig
  audio?: AudioConfig
  video?: VideoConfig
}

const config = defineConfig<ToolsConfig>('tools', {
  webSearch: {
    apiKey: process.env.BRAVESEARCH_API_KEY ?? '',
    count: 20,
  },
  bash: {
    cwd: process.cwd(),
  },
}, {
  schemas: toolsSchemas,
})

export default createPluginFactory<ToolsConfig>({
  id: 'tools',
  version: '1.0.0',
  description: 'Tool actors: web search, bash execution, and vision analysis',
  configDescriptor: config,
  maskKeys: ['apiKey'],
  slots: {
    webSearch: {
      factory: (cfg) => cfg ? WebSearch(cfg) : null,
      configPath: 'webSearch',
    },
    bash: {
      factory: (cfg) => BashTool(cfg ?? undefined),
      configPath: 'bash',
    },
    vision: {
      factory: (cfg) => cfg ? Vision({ model: cfg.model }) : null,
      configPath: 'vision',
    },
    audio: {
      factory: (cfg) => cfg ? Audio({ ttsModel: cfg.ttsModel, sttModel: cfg.sttModel, voice: cfg.voice ?? 'alloy' }) : null,
      configPath: 'audio',
    },
    video: {
      factory: (cfg) => cfg ? Video({ model: cfg.model, aspectRatio: cfg.aspectRatio, duration: cfg.duration, resolution: cfg.resolution, pollIntervalMs: cfg.pollIntervalMs, pollTimeoutMs: cfg.pollTimeoutMs }) : null,
      configPath: 'video',
    },
    cron: {
      factory: () => Cron(),
    },
    pdf: {
      factory: () => PDF(),
    },
    fetchFile: {
      factory: () => FetchFile(),
    },
    toolStatus: {
      factory: () => ToolStatus(),
    },
  },
  tools: {
    webSearch: { schema: webSearchTool.schema, slot: 'webSearch' },
    bash: { schema: bashTool.schema, slot: 'bash' },
    write: { schema: writeTool.schema, slot: 'bash' },
    read: { schema: readTool.schema, slot: 'bash' },
    edit: { schema: editTool.schema, slot: 'bash' },
    cronCreate: { schema: cronCreateTool.schema, slot: 'cron' },
    cronDelete: { schema: cronDeleteTool.schema, slot: 'cron' },
    cronList: { schema: cronListTool.schema, slot: 'cron' },
    pdf: { schema: pdfTool.schema, slot: 'pdf' },
    fetchFile: { schema: fetchFileTool.schema, slot: 'fetchFile' },
    toolStatus: { schema: toolStatusTool.schema, slot: 'toolStatus' },
    analyzeImage: { schema: analyzeImageTool.schema, slot: 'vision' },
    generateImage: { schema: generateImageTool.schema, slot: 'vision' },
    transcribeAudio: { schema: transcribeAudioTool.schema, slot: 'audio' },
    textToSpeech: { schema: textToSpeechTool.schema, slot: 'audio' },
    generateVideo: { schema: generateVideoTool.schema, slot: 'video', mayBeLongRunning: true },
  },
})
