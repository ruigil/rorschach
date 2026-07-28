export type PluginHealthStatus = 'ok' | 'degraded' | 'unavailable'

export type PluginHealthReport = {
  status: PluginHealthStatus
  /** Human-readable explanation, e.g. "webSearch slot disabled: BRAVESEARCH_API_KEY missing" */
  detail?: string
  updatedAt: number
}

export type PluginHealthUpdateMsg = {
  type: 'healthStatus'
  status: PluginHealthStatus
  detail?: string
}
