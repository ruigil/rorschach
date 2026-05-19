export type WSFrameType = 
  | 'chunk'
  | 'done'
  | 'error'
  | 'tooling'
  | 'sources'
  | 'attachments'
  | 'reasoningChunk'
  | 'plannerMode'
  | 'modeChanged'
  | 'agents'
  | 'planGraph'
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
