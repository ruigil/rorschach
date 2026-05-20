export const TABS = ['chat', 'config', 'observe'] as const
export type Tab = typeof TABS[number]

export const DEFAULT_TAB: Tab = 'chat'

export const OBSERVE_TABS = ['metrics', 'topics', 'logs', 'traces', 'tools', 'memory', 'costs'] as const
export type ObserveTab = typeof OBSERVE_TABS[number]

export const DEFAULT_OBSERVE_TAB: ObserveTab = 'metrics'
