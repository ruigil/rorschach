import type { ActorDef, ActorContext, ActorRef, ActorResult, Interceptor } from '../../system/index.ts'
import { agentLoop, ask, idleLoopState, type LoopState } from '../../system/index.ts'
import { defineTool, parseToolArgs } from '../../system/index.ts'
import type { ToolCollection, ToolMsg, ToolReply } from '../../types/tools.ts'
import type { LlmProviderMsg } from '../../types/llm.ts'
import type { MessageAttachment } from '../../types/events.ts'
import type {
  ConceptSearchReply,
  KgraphMsg,
  MemoryRecallMsg,
  MemoryRecord,
  MemoryRecordsMsg,
  MemorySearchConcept,
  MemorySupervisorMsg,
} from './types.ts'
import { recallSynthesisPrompt } from './ontology.ts'

export const memoryRecallTool = defineTool('recall_memory', 'Retrieve relevant memories from concept nodes, navigate the memory graph when useful, hydrate selected source records, and return a sourced answer.', {
  type: 'object',
  properties: {
    query: { type: 'string', description: 'What to look up. Be specific.' },
  },
  required: ['query'],
})

const memorySearchTool = defineTool('memory_search', 'Search memory concepts by query.', {
  type: 'object',
  properties: {
    query: { type: 'string', description: 'Start a new semantic search over memory concepts.' },
  },
  required: ['query'],
})

const memoryExpandTool = defineTool('memory_expand', 'Expand one memory concept by nodeId one graph hop.', {
  type: 'object',
  properties: {
    nodeId: { type: 'number', description: 'Concept nodeId to expand by one graph hop.' },
  },
  required: ['nodeId'],
})

const memoryReadTool = defineTool('memory_read', 'Read selected verbatim memory records by recordId. Use this before answering; concept metadata is not final evidence.', {
  type: 'object',
  properties: {
    recordIds: { type: 'array', items: { type: 'string' }, description: 'Record IDs selected from memory_search or memory_expand results.' },
  },
  required: ['recordIds'],
})

const MAX_SEARCH_RESULTS = 8
const MAX_EXPANSION_RESULTS = 8
const MAX_LINK_STUBS = 5
const MAX_RECORDS_READ = 8

export type MemoryRecallWorkerOptions = {
  model:        string
  maxToolLoops: number
  recordsRef:   ActorRef<MemoryRecordsMsg>
  kgraphRef:    ActorRef<KgraphMsg>
  llmRef:       ActorRef<LlmProviderMsg>
}

export type MemoryRecallWorkerState = {
  loop:          LoopState
  replyTo:       ActorRef<ToolReply> | null
  selfRef:       ActorRef<MemoryRecallMsg> | null
  llmRef:        ActorRef<LlmProviderMsg> | null
  recordsRef:    ActorRef<MemoryRecordsMsg>
  kgraphRef:     ActorRef<KgraphMsg>
  currentQuery:  string
  readRecordIds: Set<string>
  seedRecordIds: string[]
  sources:       MemoryRecord[]
  fallbackUsed:  boolean
}

const unique = (values: string[]): string[] => Array.from(new Set(values.filter(Boolean)))

const clampArray = <T>(values: T[], max: number): T[] => values.slice(0, max)

const sourcePayload = (sources: MemoryRecord[]) =>
  sources.map(source => ({
    recordId: source.recordId,
    title: source.title,
    createdAt: source.createdAt,
    attachments: source.attachments,
    content: source.content,
  }))

const toPublicMediaUrl = (url: string): string => {
  if (
    url.startsWith('http://') ||
    url.startsWith('https://') ||
    url.startsWith('data:') ||
    url.startsWith('blob:') ||
    url.startsWith('inbound/') ||
    url.startsWith('generated/') ||
    url.startsWith('/inbound/') ||
    url.startsWith('/generated/')
  ) {
    return url
  }

  const marker = '/workspace/media/'
  const index = url.indexOf(marker)
  return index >= 0 ? url.slice(index + marker.length) : url
}

const toPublicMediaAttachment = (attachment: MessageAttachment): MessageAttachment => ({
  ...attachment,
  url: toPublicMediaUrl(attachment.url),
})

const sourceAttachments = (sources: MemoryRecord[]): MessageAttachment[] | undefined => {
  const seen = new Set<string>()
  const attachments: MessageAttachment[] = []
  for (const source of sources) {
    for (const attachment of source.attachments ?? []) {
      const publicAttachment = toPublicMediaAttachment(attachment)
      if (seen.has(publicAttachment.url)) continue
      seen.add(publicAttachment.url)
      attachments.push(publicAttachment)
    }
  }
  return attachments.length > 0 ? attachments : undefined
}

const buildUserPrompt = (query: string, sources: MemoryRecord[]): string => {
  const sourceBlocks = sources.map((source, index) =>
    `Source ${index + 1}\nrecordId: ${source.recordId}\n\n${source.content}`
  ).join('\n\n---\n\n')
  return `Query:\n${query}\n\nSources:\n${sourceBlocks}`
}

const searchReplyText = (concepts: MemorySearchConcept[]): string =>
  JSON.stringify({ concepts })

const searchResultLogPayload = (concepts: MemorySearchConcept[]) => ({
  count: concepts.length,
  concepts: concepts.map(concept => ({
    nodeId: concept.nodeId,
    score: concept.score,
    name: concept.name,
    kind: concept.kind,
    recordIds: concept.recordIds,
    links: concept.links.map(link => ({
      type: link.type,
      nodeId: link.nodeId,
      name: link.name,
      kind: link.kind,
      confidence: link.confidence,
    })),
  })),
})

const runMemorySearch = async (
  state: MemoryRecallWorkerState,
  userId: string,
  rawArgs: string,
  ctx: ActorContext<MemoryRecallMsg>,
): Promise<string> => {
  const parsed = parseToolArgs<{ query: string }>(rawArgs, (p) => {
    const query = typeof p.query === 'string' ? p.query.trim() : ''
    return query ? { query } : null
  }, 'Missing query argument')
  if (!parsed.ok) throw new Error(parsed.error)

  ctx.log.info('memory recall search arguments', {
    userId,
    query: parsed.value.query,
    topN: MAX_SEARCH_RESULTS,
    linkLimit: MAX_LINK_STUBS,
  })

  const reply = await ask<KgraphMsg, ConceptSearchReply>(
    state.kgraphRef,
    (replyTo) => ({
      type: 'conceptSearch',
      query: parsed.value.query,
      topN: MAX_SEARCH_RESULTS,
      linkLimit: MAX_LINK_STUBS,
      userId,
      replyTo,
    }),
  )
  if (reply.type !== 'conceptSearchResult') throw new Error(reply.error)
  ctx.log.info('memory recall search result', {
    userId,
    query: parsed.value.query,
    ...searchResultLogPayload(reply.concepts),
  })

  if (state.seedRecordIds.length === 0) {
    state.seedRecordIds = unique(reply.concepts.flatMap(concept => concept.recordIds)).slice(0, MAX_RECORDS_READ)
  }

  return searchReplyText(reply.concepts)
}

const runMemoryExpand = async (
  state: MemoryRecallWorkerState,
  userId: string,
  rawArgs: string,
  ctx: ActorContext<MemoryRecallMsg>,
): Promise<string> => {
  const parsed = parseToolArgs<{ nodeId: number }>(rawArgs, (p) => {
    const nodeId = typeof p.nodeId === 'number' && Number.isFinite(p.nodeId) ? p.nodeId : undefined
    return nodeId !== undefined ? { nodeId } : null
  }, 'Missing nodeId argument')
  if (!parsed.ok) throw new Error(parsed.error)

  ctx.log.info('memory recall expand arguments', {
    userId,
    nodeId: parsed.value.nodeId,
    limit: MAX_EXPANSION_RESULTS,
    linkLimit: MAX_LINK_STUBS,
  })

  const reply = await ask<KgraphMsg, ConceptSearchReply>(
    state.kgraphRef,
    (replyTo) => ({
      type: 'conceptExpand',
      nodeId: parsed.value.nodeId,
      limit: MAX_EXPANSION_RESULTS,
      linkLimit: MAX_LINK_STUBS,
      userId,
      replyTo,
    }),
  )
  if (reply.type !== 'conceptSearchResult') throw new Error(reply.error)
  ctx.log.info('memory recall expand result', {
    userId,
    nodeId: parsed.value.nodeId,
    ...searchResultLogPayload(reply.concepts),
  })
  return searchReplyText(reply.concepts)
}

const runMemoryRead = async (
  state: MemoryRecallWorkerState,
  userId: string,
  rawArgs: string,
): Promise<string> => {
  const parsed = parseToolArgs<{ recordIds: string[] }>(rawArgs, (p) => {
    const recordIds = Array.isArray(p.recordIds)
      ? p.recordIds.filter((value): value is string => typeof value === 'string')
      : []
    return recordIds.length > 0 ? { recordIds } : null
  }, 'Missing recordIds argument')
  if (!parsed.ok) throw new Error(parsed.error)

  const recordIds = clampArray(unique(parsed.value.recordIds), MAX_RECORDS_READ)
  const unread = recordIds.filter(id => !state.readRecordIds.has(id))
  for (const id of unread) state.readRecordIds.add(id)

  const records = unread.length === 0
    ? []
    : await ask<MemoryRecordsMsg, MemoryRecord[]>(
      state.recordsRef,
      (replyTo) => ({ type: 'readMany', recordIds: unread, userId, replyTo }),
    )
  const existing = new Set(state.sources.map(source => source.recordId))
  for (const record of records) {
    if (!existing.has(record.recordId)) {
      state.sources.push(record)
      existing.add(record.recordId)
    }
  }
  return JSON.stringify({ records: sourcePayload(records) })
}

const recallTools = (state: MemoryRecallWorkerState): ToolCollection => {
  if (!state.selfRef) return {}
  const ref = state.selfRef as unknown as ActorRef<ToolMsg>
  return {
    [memorySearchTool.name]: { name: memorySearchTool.name, schema: memorySearchTool.schema, ref },
    [memoryExpandTool.name]: { name: memoryExpandTool.name, schema: memoryExpandTool.schema, ref },
    [memoryReadTool.name]: { name: memoryReadTool.name, schema: memoryReadTool.schema, ref },
  }
}

export const MemoryRecallWorker = (parent: ActorRef<MemorySupervisorMsg>, options: MemoryRecallWorkerOptions): ActorDef<MemoryRecallMsg, MemoryRecallWorkerState> => {
  const resetForQuery = (state: MemoryRecallWorkerState, query: string, replyTo: ActorRef<ToolReply>, selfRef: ActorRef<MemoryRecallMsg>): MemoryRecallWorkerState => ({
    ...state,
    replyTo,
    selfRef,
    currentQuery: query,
    readRecordIds: new Set(),
    seedRecordIds: [],
    sources: [],
    fallbackUsed: false,
  })

  const handleInvoke = (state: MemoryRecallWorkerState, msg: Extract<MemoryRecallMsg, { type: 'invoke' }>, ctx: ActorContext<MemoryRecallMsg>): ActorResult<MemoryRecallMsg, MemoryRecallWorkerState> => {
    const parsed = parseToolArgs<{ query: string }>(msg.arguments, (p) => {
      const query = typeof p.query === 'string' ? p.query : ''
      return query ? { query } : null
    }, 'Missing query argument')

    if (!parsed.ok) {
      msg.replyTo.send({ type: 'toolError', error: parsed.error })
      return { state }
    }

    if (!state.llmRef) {
      msg.replyTo.send({ type: 'toolError', error: 'Memory not ready' })
      return { state }
    }

    return loop.startTurn(
      resetForQuery(state, parsed.value.query, msg.replyTo, ctx.self),
      {
        messages: [
          { role: 'system', content: recallSynthesisPrompt(msg.userId) },
          { role: 'user', content: `Query:\n${parsed.value.query}` },
        ],
        userId: msg.userId,
      },
      ctx,
    )
  }

  const handleLocalTool = (state: MemoryRecallWorkerState, msg: Extract<MemoryRecallMsg, { type: 'invoke' }>, ctx: ActorContext<MemoryRecallMsg>): ActorResult<MemoryRecallMsg, MemoryRecallWorkerState> => {
    const run =
      msg.toolName === memorySearchTool.name ? runMemorySearch(state, msg.userId, msg.arguments, ctx)
      : msg.toolName === memoryExpandTool.name ? runMemoryExpand(state, msg.userId, msg.arguments, ctx)
      : runMemoryRead(state, msg.userId, msg.arguments)
    ctx.pipeToSelf(
      run,
      (text) => ({ type: '_localToolDone' as const, replyTo: msg.replyTo, text }),
      (error) => ({ type: '_localToolErr' as const, replyTo: msg.replyTo, error: String(error) }),
    )
    return { state }
  }

  const loop = agentLoop<MemoryRecallWorkerState, MemoryRecallMsg>({
    role: 'memory-recall',
    spanName: 'memory-recall',
    logPrefix: 'memory recall',
    model: options.model,
    maxToolLoops: options.maxToolLoops,
    llmRef: (s) => s.llmRef,
    tools: recallTools,

    onComplete: (state, finalText, _usage, ctx) => {
      if (state.sources.length === 0 && state.seedRecordIds.length > 0 && !state.fallbackUsed) {
        ctx.pipeToSelf(
          ask<MemoryRecordsMsg, MemoryRecord[]>(
            state.recordsRef,
            (replyTo) => ({ type: 'readMany', recordIds: state.seedRecordIds, userId: state.loop.turn.userId, replyTo }),
          ),
          (sources) => ({ type: '_fallbackSources' as const, sources, userId: state.loop.turn.userId }),
          (error) => ({ type: '_fallbackErr' as const, error: String(error) }),
        )
        return { state: { ...state, fallbackUsed: true } }
      }

      state.replyTo?.send({
        type: 'toolResult',
        result: {
          text: JSON.stringify({
            answer: state.sources.length > 0 ? (finalText || '(no result)') : 'No relevant memory sources were found.',
            sources: sourcePayload(state.sources),
          }),
          attachments: sourceAttachments(state.sources),
        },
      })
      parent.send({ type: '_workerDone', worker: { name: ctx.self.name } })
      return { state }
    },

    onError: (state, err, ctx) => {
      state.replyTo?.send({ type: 'toolError', error: err.kind === 'llm' ? String(err.error) : 'Tool loop limit reached' })
      parent.send({ type: '_workerDone', worker: { name: ctx.self.name } })
      return { state }
    },
  })

  const hostInterceptor: Interceptor<MemoryRecallMsg, MemoryRecallWorkerState> = (state, msg, ctx, next) => {
    const m = msg as MemoryRecallMsg

    if (m.type === 'invoke') {
      if (m.toolName === memorySearchTool.name || m.toolName === memoryExpandTool.name || m.toolName === memoryReadTool.name) {
        return handleLocalTool(state, m, ctx)
      }
      if (state.loop.phase !== 'idle') return { state, stash: true }
      return handleInvoke(state, m, ctx)
    }

    if (m.type === '_localToolDone') {
      m.replyTo.send({ type: 'toolResult', result: { text: m.text } })
      return { state }
    }

    if (m.type === '_localToolErr') {
      m.replyTo.send({ type: 'toolError', error: m.error })
      return { state }
    }

    if (m.type === '_fallbackSources') {
      if (m.sources.length === 0) {
        state.replyTo?.send({ type: 'toolResult', result: { text: JSON.stringify({ answer: 'No relevant memory sources were found.', sources: [] }) } })
        parent.send({ type: '_workerDone', worker: { name: ctx.self.name } })
        return { state }
      }
      return loop.startTurn(
        { ...state, sources: m.sources },
        {
          messages: [
            { role: 'system', content: recallSynthesisPrompt(m.userId) },
            { role: 'user', content: buildUserPrompt(state.currentQuery, m.sources) },
          ],
          userId: m.userId,
        },
        ctx,
      )
    }

    if (m.type === '_fallbackErr') {
      state.replyTo?.send({ type: 'toolResult', result: { text: JSON.stringify({ answer: 'No relevant memory sources were found.', sources: [], warnings: [m.error] }) } })
      parent.send({ type: '_workerDone', worker: { name: ctx.self.name } })
      return { state }
    }

    return next(state, msg)
  }

  return {
    initialState: () => ({
      loop: idleLoopState(),
      replyTo: null,
      selfRef: null,
      llmRef: options.llmRef,
      recordsRef: options.recordsRef,
      kgraphRef: options.kgraphRef,
      currentQuery: '',
      readRecordIds: new Set(),
      seedRecordIds: [],
      sources: [],
      fallbackUsed: false,
    }),
    handler: loop.idle,
    interceptors: [hostInterceptor],
  }
}
