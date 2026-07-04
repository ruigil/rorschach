import { store } from '@rorschach/webkit';
import type { Actor, Topic, LogEvent, TraceSpan, UsageEntry } from '@rorschach/webkit/types.js';
import { RObservePanel } from './r-observe-panel.js'

export { RObservePanel }

export interface ObservabilityState {
  actors: Actor[]
  topics: Topic[]
  logs: LogEvent[]
  traces: TraceSpan[]
  usage: UsageEntry[]
}

declare module '@rorschach/webkit/runtime/store.js' {
  interface NamespaceRegistry {
    observe: ObservabilityState
  }
}

const storeNamespace = store.namespace<ObservabilityState>('observe')
storeNamespace.init({
  actors: [],
  topics: [],
  logs: [],
  traces: [],
  usage: [],
})

export const reduceFrame = (frame: any) => {
  const ns = store.namespace<ObservabilityState>('observe')
  if (frame.type === 'log') {
    const currentLogs = ns.get('logs') ?? []
    const entry: LogEvent = {
      timestamp: frame.timestamp ?? Date.now(),
      level: frame.level ?? 'info',
      source: frame.source ?? '',
      message: frame.message,
      data: frame.data,
    }
    ns.set('logs', [entry, ...currentLogs].slice(0, 500))
  } else if (frame.type === 'metrics') {
    if (frame.actors) ns.set('actors', frame.actors)
    if (frame.topics) ns.set('topics', frame.topics)
  } else if (frame.type === 'trace') {
    ns.set('traces', [...(ns.get('traces') ?? []), frame as TraceSpan])
  } else if (frame.type === 'usage') {
    ns.set('usage', [...(ns.get('usage') ?? []), frame as UsageEntry])
  }
}
