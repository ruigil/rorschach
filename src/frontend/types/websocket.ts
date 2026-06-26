import type { UiSurfaceRegistration } from '../../types/ui-surface.js'

export type WSFrameType =
  | 'chunk'
  | 'done'
  | 'error'
  | 'tooling'
  | 'sources'
  | 'attachments'
  | 'reasoningChunk'
  | 'modeChanged'
  | 'agents'
  | 'workflowGraph'
  | 'workflowRunUpdated'
  | 'docWorkspace'
  | 'ui.surface'
  | 'usage'
  | 'log'
  | 'metrics'
  | 'trace'
  | 'tool_registered'
  | 'tool_unregistered'

export type WSFrame = {
  type: WSFrameType
  [key: string]: any
};

export type ChunkFrame = WSFrame & {
  type: 'chunk'
  text: string
};

export type AgentsFrame = WSFrame & {
  type: 'agents'
  agents: any[]
};

export type UiSurfaceFrame = WSFrame & {
  type: 'ui.surface'
  reg: UiSurfaceRegistration
};
