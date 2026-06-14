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
  | 'usage'
  | 'log'
  | 'metrics'
  | 'trace'
  | 'tool_registered'
  | 'tool_unregistered'

export interface WSFrame {
  type: WSFrameType
  [key: string]: any
}

export interface ChunkFrame extends WSFrame {
  type: 'chunk'
  text: string
}

export interface AgentsFrame extends WSFrame {
  type: 'agents'
  agents: any[]
}
