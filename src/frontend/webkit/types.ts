// ─── Neutral data shapes rendered by frontend/webkit primitives ───


export type LogEvent = {
  timestamp: number
  level: 'debug' | 'info' | 'warn' | 'error'
  source: string
  message: string
  data?: Record<string, unknown>
};

