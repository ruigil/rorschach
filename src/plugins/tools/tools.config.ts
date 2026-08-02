import { defineConfig } from '../../system/index.ts'
import type { ConfigSchemaSection } from '../../types/config.ts'
import type { WebSearchActorOptions } from './types.ts'

// ─── Config type ────────────────────────────────────────────────────────────

export type ToolsConfig = {
  webSearch?: WebSearchActorOptions

  vision?: {
    model: string
    analysisModel?: string
  }
  audio?: {
    ttsModel: string
    sttModel: string
    voice?: string
  }
  video?: {
    model: string
    aspectRatio?: string
    duration?: number
    resolution?: string
    pollIntervalMs?: number
    pollTimeoutMs?: number
  }
}

// ─── Schema sections ────────────────────────────────────────────────────────

const webSearchSchema: ConfigSchemaSection = {
  id: 'tools.webSearch',
  title: 'Web Search',
  subtitle: 'tools · Brave search',
  tab: 'tools',
  configKey: 'webSearch',
  schema: {
    type: 'object',
    properties: {
      count: { type: 'number', default: 20, minimum: 1, maximum: 100, 'x-ui': { label: 'Result count' } },
    },
  },
}

const visionSchema: ConfigSchemaSection = {
  id: 'tools.vision',
  title: 'Vision',
  subtitle: 'tools · image analysis and generation',
  tab: 'tools',
  configKey: 'vision',
  schema: {
    type: 'object',
    properties: {
      model: { type: 'string', 'x-ui': { widget: 'model-select', label: 'Vision generation model' } },
      analysisModel: { type: 'string', 'x-ui': { widget: 'model-select', label: 'Vision analysis model' } },
    },
  },
}

const audioSchema: ConfigSchemaSection = {
  id: 'tools.audio',
  title: 'Audio',
  subtitle: 'tools · speech-to-text and text-to-speech',
  tab: 'tools',
  configKey: 'audio',
  schema: {
    type: 'object',
    properties: {
      ttsModel: { type: 'string', 'x-ui': { widget: 'model-select', label: 'TTS model' } },
      sttModel: { type: 'string', 'x-ui': { widget: 'model-select', label: 'STT model' } },
      voice: { type: 'string', default: 'alloy', 'x-ui': { widget: 'voice-select', label: 'Voice' }, enum: ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'] },
    },
  },
}

const videoSchema: ConfigSchemaSection = {
  id: 'tools.video',
  title: 'Video',
  subtitle: 'tools · video generation',
  tab: 'tools',
  configKey: 'video',
  schema: {
    type: 'object',
    properties: {
      model: { type: 'string', 'x-ui': { widget: 'model-select', label: 'Video model' } },
    },
  },
}

const toolsSchemas: ConfigSchemaSection[] = [webSearchSchema, visionSchema, audioSchema, videoSchema]

// ─── Defaults + descriptor ──────────────────────────────────────────────────

export const config = defineConfig<ToolsConfig>('tools', {
  webSearch: {
    apiKey: process.env.BRAVESEARCH_API_KEY ?? '',
    count: 20,
  },
}, {
  schemas: toolsSchemas,
})