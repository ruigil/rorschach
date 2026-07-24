import { createPluginFactory } from '../../system/index.ts'
import { WebSearch, webSearchTool } from './web-search.ts'
import { Vision, analyzeImageTool, generateImageTool } from './vision-actor.ts'
import { Cron, cronCreateTool, cronDeleteTool, cronListTool } from './cron.ts'
import { Audio, transcribeAudioTool, textToSpeechTool } from './audio.ts'
import { Video, generateVideoTool } from './video-actor.ts'
import { PDF, pdfTool } from './pdf.ts'
import { FetchFile, fetchFileTool } from './fetch-file.ts'
import { ToolStatus, toolStatusTool } from './tool-status.ts'
import { defineConfig } from '../../system/index.ts'
import { toolsSchemas } from './routes.ts'
import type { ToolsConfig } from './types.ts'

const config = defineConfig<ToolsConfig>('tools', {
  webSearch: {
    apiKey: process.env.BRAVESEARCH_API_KEY ?? '',
    count: 20,
  },
}, {
  schemas: toolsSchemas,
})

export default createPluginFactory<ToolsConfig>({
  id: 'tools',
  version: '1.0.0',
  description: 'Tool actors: web search, vision, audio, video, cron, PDF, and file fetch',
  configDescriptor: config,
  maskKeys: ['apiKey'],
  slots: {
    webSearch: {
      factory: (cfg) => cfg ? WebSearch(cfg) : null,
      configPath: 'webSearch',
    },
    vision: {
      factory: (cfg) => cfg ? Vision({ model: cfg.model, analysisModel: cfg.analysisModel }) : null,
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
    cronCreate: { schema: cronCreateTool.schema, slot: 'cron', mayBeLongRunning: true },
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
