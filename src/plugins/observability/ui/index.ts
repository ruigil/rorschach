import { store, send } from '@rorschach/webkit';
import type { LogEvent } from '@rorschach/webkit/types.js';
import type { Actor, Topic, TraceSpan, UsageEntry } from '../types.js';
import { RObservePanel } from './r-observe-panel.js';
import { RScramblersList } from './r-scramblers-list.js';

export { RObservePanel, RScramblersList };

export type ObservabilityState = {
  actors: Actor[]
  topics: Topic[]
  logs: LogEvent[]
  traces: TraceSpan[]
  usage: UsageEntry[]
  scramblers: Record<string, {
    urn: string
    kind: string
    description: string
    schema: {
      inputSchema?: Record<string, any>
      outputSchema?: Record<string, any>
    }
    tags?: string[]
    yieldsPending?: boolean
    meta?: any
  }>
  activeTab: string
  kgraph: any | null
}

declare module '@rorschach/webkit/runtime/store.js' {
  // eslint-disable-next-line @typescript-eslint/consistent-type-definitions
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
  scramblers: {},
  activeTab: 'metrics',
  kgraph: null,
})

let debounceTimeout: any = null

export const reduceFrame = (frame: any) => {
  const ns = store.namespace<ObservabilityState>('observe')
  if (frame.type === 'observability.log.entry') {
    const currentLogs = ns.get('logs') ?? []
    const entry: LogEvent = {
      timestamp: frame.timestamp ?? Date.now(),
      level: frame.level ?? 'info',
      source: frame.source ?? '',
      message: frame.message,
      data: frame.data,
    }
    ns.set('logs', [entry, ...currentLogs].slice(0, 500))
  } else if (frame.type === 'observability.metrics.updated') {
    if (frame.actors) ns.set('actors', frame.actors)
    if (frame.topics) ns.set('topics', frame.topics)
  } else if (frame.type === 'observability.trace.span') {
    ns.set('traces', [...(ns.get('traces') ?? []), frame as TraceSpan])
  } else if (frame.type === 'observability.usage.entry') {
    ns.set('usage', [...(ns.get('usage') ?? []), frame as UsageEntry])
  } else if (frame.type === 'scramblers.registered') {
    ns.set('scramblers', { ...ns.get('scramblers'), [frame.descriptor.urn]: frame.descriptor })
  } else if (frame.type === 'scramblers.unregistered') {
    const nextScramblers = { ...ns.get('scramblers') }
    delete nextScramblers[frame.urn]
    ns.set('scramblers', nextScramblers)
  } else if (frame.type === 'memory.kgraph.updated') {
    ns.set('kgraph', frame.graph)
  } else if (frame.type === 'memory.kgraph.changed') {
    const activeTab = ns.get('activeTab')
    if (activeTab === 'memory') {
      if (debounceTimeout) clearTimeout(debounceTimeout)
      debounceTimeout = setTimeout(() => {
        send({ type: 'memory.kgraph.request' })
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
