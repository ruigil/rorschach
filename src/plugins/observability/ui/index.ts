import { store, send } from '@rorschach/webkit';
import type { LogEvent } from '@rorschach/webkit/types.js';
import type { Actor, Topic, TraceSpan, UsageEntry } from '../types.js';
import { RObservePanel } from './r-observe-panel.js'

export { RObservePanel }

export interface ObservabilityState {
  actors: Actor[]
  topics: Topic[]
  logs: LogEvent[]
  traces: TraceSpan[]
  usage: UsageEntry[]
  tools: Record<string, { type: 'function'; function: { name: string; description: string; parameters: object } }>
  activeTab: string
  kgraph: any | null
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
  tools: {},
  activeTab: 'metrics',
  kgraph: null,
})

let debounceTimeout: any = null

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
  } else if (frame.type === 'tool_registered') {
    ns.set('tools', { ...ns.get('tools'), [frame.name]: frame.schema })
  } else if (frame.type === 'tool_unregistered') {
    const nextTools = { ...ns.get('tools') }
    delete nextTools[frame.name]
    ns.set('tools', nextTools)
  } else if (frame.type === 'observe.kgraph.updated') {
    ns.set('kgraph', frame.graph)
  } else if (frame.type === 'observe.kgraph.changed') {
    const activeTab = ns.get('activeTab')
    if (activeTab === 'memory') {
      if (debounceTimeout) clearTimeout(debounceTimeout)
      debounceTimeout = setTimeout(() => {
        send({ type: 'observe.kgraph.request' })
      }, 1000)
    } else {
      if (debounceTimeout) {
        clearTimeout(debounceTimeout)
        debounceTimeout = null
      }
      ns.set('kgraph', null)
    }
  }
}
