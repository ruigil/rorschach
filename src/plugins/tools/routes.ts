import type { ConfigSchemaSection } from '../../types/config.ts'

// ─── Config Schema Sections ──────────────────────────────────────────────────

export const bashSchema: ConfigSchemaSection = {
  id: 'tools.bash',
  title: 'Bash',
  subtitle: 'tools · shell execution',
  tab: 'tools',
  configKey: 'bash',
  routeId: 'config.tools',
  schema: {
    type: 'object',
    properties: {
      cwd: { type: 'string', default: '/workspace', 'x-ui': { label: 'Working directory' } },
    },
  },
}

export const webSearchSchema: ConfigSchemaSection = {
  id: 'tools.webSearch',
  title: 'Web Search',
  subtitle: 'tools · Brave search',
  tab: 'tools',
  configKey: 'webSearch',
  routeId: 'config.tools',
  schema: {
    type: 'object',
    properties: {
      count: { type: 'number', default: 20, minimum: 1, maximum: 100, 'x-ui': { label: 'Result count' } },
    },
  },
}

export const visionSchema: ConfigSchemaSection = {
  id: 'tools.vision',
  title: 'Vision',
  subtitle: 'tools · image analysis and generation',
  tab: 'tools',
  configKey: 'vision',
  routeId: 'config.tools',
  schema: {
    type: 'object',
    properties: {
      model: { type: 'string', 'x-ui': { widget: 'model-select', label: 'Vision generation model' } },
      analysisModel: { type: 'string', 'x-ui': { widget: 'model-select', label: 'Vision analysis model' } },
    },
  },
}

export const audioSchema: ConfigSchemaSection = {
  id: 'tools.audio',
  title: 'Audio',
  subtitle: 'tools · speech-to-text and text-to-speech',
  tab: 'tools',
  configKey: 'audio',
  routeId: 'config.tools',
  schema: {
    type: 'object',
    properties: {
      ttsModel: { type: 'string', 'x-ui': { widget: 'model-select', label: 'TTS model' } },
      sttModel: { type: 'string', 'x-ui': { widget: 'model-select', label: 'STT model' } },
      voice: { type: 'string', default: 'alloy', 'x-ui': { widget: 'voice-select', label: 'Voice' }, enum: ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'] },
    },
  },
}

export const videoSchema: ConfigSchemaSection = {
  id: 'tools.video',
  title: 'Video',
  subtitle: 'tools · video generation',
  tab: 'tools',
  configKey: 'video',
  routeId: 'config.tools',
  schema: {
    type: 'object',
    properties: {
      model: { type: 'string', 'x-ui': { widget: 'model-select', label: 'Video model' } },
    },
  },
}

export const toolsSchemas = [bashSchema, webSearchSchema, visionSchema, audioSchema, videoSchema]
