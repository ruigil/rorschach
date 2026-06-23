import type { ActorContext, ActorDef, ActorRef } from '../../system/index.ts'
import { ask, onLifecycle, onMessage } from '../../system/index.ts'
import { ContextSnapshotTopic, type ContextTurn } from '../../types/agents.ts'
import type {
  ApiMessage,
  LlmProviderMsg,
  LlmProviderReply,
} from '../../types/llm.ts'
import { LlmProviderTopic } from '../../types/llm.ts'
import type {
  ConceptLinksReply,
  KgraphMsg,
  LinkCandidatesReply,
  LinkConsolidationCandidate,
  MemoryConceptLink,
  MemoryConsolidationMsg,
  MemoryLinkType,
  MemorySearchConcept,
} from './types.ts'
import { MEMORY_LINK_TYPES } from './types.ts'

// ─── Options ───

export type MemoryConsolidationOptions = {
  model:      string
  intervalMs: number
  kgraphRef:  ActorRef<KgraphMsg>
}

type ActiveRequest = {
  requestId:   string
  userId:      string
  accumulated: string
  candidates:  LinkConsolidationCandidate[]
}

export type ConsolidationState = {
  llmRef:      ActorRef<LlmProviderMsg> | null
  kgraphRef:   ActorRef<KgraphMsg>
  latestTurns: Record<string, ContextTurn[]>
  active:      Record<string, ActiveRequest>
}

type LinkExtraction = {
  links?: MemoryConceptLink[]
}

const MIN_CONSOLIDATION_CONFIDENCE = 0.75
const DEFAULT_CANDIDATE_LIMIT = 8
const DEFAULT_ANCHORS_PER_TARGET = 6
const DEFAULT_LINK_STUBS = 5

const compactConcept = (concept: MemorySearchConcept) => ({
  nodeId: concept.nodeId,
  name: concept.name,
  kind: concept.kind,
  description: concept.description,
  topics: concept.topics,
  aliases: concept.aliases,
  recordIds: concept.recordIds,
  links: concept.links.map(link => ({
    type: link.type,
    nodeId: link.nodeId,
    name: link.name,
    kind: link.kind,
    confidence: link.confidence,
  })),
})

const compactCandidates = (candidates: LinkConsolidationCandidate[]) =>
  candidates.map(candidate => ({
    reason: candidate.reason,
    target: compactConcept(candidate.target),
    anchors: candidate.anchors.map(compactConcept),
  }))

const buildSystemPrompt = (userId: string): string =>
  `You are a memory graph consolidation agent for user "${userId}".\n\n` +
  `Your job is to improve retrieval by linking poorly connected existing Concept nodes to relevant existing anchor Concept nodes.\n\n` +
  `Rules:\n` +
  `- Only link concepts present in the candidate payload. Use exact concept names.\n` +
  `- Prefer links from weak target concepts to relevant, better-connected anchors when that improves retrievability.\n` +
  `- Do not link weak concepts together unless the relationship is clearly meaningful.\n` +
  `- Only emit SAME_AS, ABOUT, PART_OF, CONSTRAINS, DEPENDS_ON, CONTRADICTS, PRECEDES, or CAUSES.\n` +
  `- Use SAME_AS only for aliases or duplicates, ABOUT for facts/decisions/tasks/events about a subject, PART_OF for details inside broader projects or workflows, CONSTRAINS for rules/preferences/requirements that limit action, DEPENDS_ON for prerequisites or blockers, CONTRADICTS for conflicts, PRECEDES for meaningful temporal order, and CAUSES only for explicit causality.\n` +
  `- Confidence: 1.0 means explicit, 0.85 means strongly supported, 0.75 means useful but indirect. Do not emit links below 0.75.\n` +
  `- Prefer no link over a weak or generic link.\n` +
  `- Return strict JSON only with shape {"links":[{"from":"Concept A","to":"Concept B","type":"PART_OF","confidence":0.85}]}.`

const buildMessages = (
  userId: string,
  turns: ContextTurn[],
  candidates: LinkConsolidationCandidate[],
): ApiMessage[] => {
  const turnList = turns.map((t, i) => {
    const date = new Date(t.timestamp).toISOString()
    return `Turn ${i + 1} [${date}]\nUser: ${t.userText}\nAssistant: ${t.assistantText}`
  }).join('\n\n')

  return [
    { role: 'system', content: buildSystemPrompt(userId) },
    {
      role: 'user',
      content:
        `Recent context snapshot:\n\n${turnList || '(empty)'}\n\n` +
        `Link candidates:\n\n${JSON.stringify(compactCandidates(candidates), null, 2)}`,
    },
  ]
}

const parseJsonObject = (text: string): Record<string, unknown> => {
  const trimmed = text.trim()
  const raw = trimmed.startsWith('```')
    ? trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
    : trimmed
  return JSON.parse(raw) as Record<string, unknown>
}

const normalizedLinkType = (value: unknown): MemoryLinkType | null => {
  if (typeof value !== 'string') return null
  const type = value.trim().toUpperCase()
  return (MEMORY_LINK_TYPES as readonly string[]).includes(type) ? type as MemoryLinkType : null
}

const normalizeLink = (
  value: unknown,
  candidateNames: Set<string>,
): MemoryConceptLink | null => {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const from = typeof raw.from === 'string' ? raw.from.trim() : ''
  const to = typeof raw.to === 'string' ? raw.to.trim() : ''
  const type = normalizedLinkType(raw.type)
  if (!from || !to || !type) return null
  if (!candidateNames.has(from) || !candidateNames.has(to)) return null
  const confidence = typeof raw.confidence === 'number' && Number.isFinite(raw.confidence)
    ? Math.max(0, Math.min(1, raw.confidence))
    : undefined
  if (confidence === undefined || confidence < MIN_CONSOLIDATION_CONFIDENCE) return null
  return { from, to, type, confidence }
}

const parseLinks = (
  text: string,
  candidates: LinkConsolidationCandidate[],
): MemoryConceptLink[] => {
  let parsed: LinkExtraction
  try {
    parsed = parseJsonObject(text) as LinkExtraction
  } catch {
    return []
  }

  const candidateNames = new Set<string>()
  for (const candidate of candidates) {
    candidateNames.add(candidate.target.name)
    for (const anchor of candidate.anchors) candidateNames.add(anchor.name)
  }

  return Array.isArray(parsed.links)
    ? parsed.links.map(link => normalizeLink(link, candidateNames)).filter((link): link is MemoryConceptLink => link !== null)
    : []
}

export const MemoryConsolidation = (options: MemoryConsolidationOptions): ActorDef<MemoryConsolidationMsg, ConsolidationState> => {
  const { model, intervalMs, kgraphRef } = options

  const startUserRequest = (
    userId: string,
    turns: ContextTurn[],
    candidates: LinkConsolidationCandidate[],
    llmRef: ActorRef<LlmProviderMsg>,
    state: ConsolidationState,
    context: ActorContext<MemoryConsolidationMsg>,
  ): ConsolidationState => {
    const requestId = crypto.randomUUID()
    llmRef.send({
      type: 'stream',
      requestId,
      model,
      messages: buildMessages(userId, turns, candidates),
      role: 'memory-consolidation',
      userId,
      replyTo: context.self as unknown as ActorRef<LlmProviderReply>,
    })
    context.log.info('memory consolidation started', { userId, candidates: candidates.length, turns: turns.length })
    return {
      ...state,
      active: {
        ...state.active,
        [userId]: { requestId, userId, accumulated: '', candidates },
      },
    }
  }

  return {
    initialState: {
      llmRef: null,
      kgraphRef,
      latestTurns: {},
      active: {},
    },
    lifecycle: onLifecycle({
      start: (state, context) => {
        context.subscribe(ContextSnapshotTopic, (e) => ({
          type: '_contextSnapshot' as const,
          userId: e.userId,
          turns: e.turns,
        }))
        context.subscribe(LlmProviderTopic, (e) => ({
          type: '_llmProvider' as const,
          ref: e.ref,
        }))
        context.timers.startPeriodicTimer('consolidation', { type: '_consolidate' }, intervalMs)
        return { state }
      },
    }),

    handler: onMessage<MemoryConsolidationMsg, ConsolidationState>({
      _contextSnapshot: (state, msg) => ({
        state: {
          ...state,
          latestTurns: {
            ...state.latestTurns,
            [msg.userId]: msg.turns,
          },
        },
      }),

      _consolidate: (state, _msg, context) => {
        if (!state.llmRef) return { state }
        for (const userId of Object.keys(state.latestTurns)) {
          if (state.active[userId]) continue
          context.pipeToSelf(
            ask<KgraphMsg, LinkCandidatesReply>(
              state.kgraphRef,
              (replyTo) => ({
                type: 'linkCandidates',
                userId,
                limit: DEFAULT_CANDIDATE_LIMIT,
                anchorsPerTarget: DEFAULT_ANCHORS_PER_TARGET,
                linkLimit: DEFAULT_LINK_STUBS,
                replyTo,
              }),
            ),
            (reply) => reply.type === 'linkCandidatesResult'
              ? ({ type: '_linkCandidatesDone' as const, userId, candidates: reply.candidates })
              : ({ type: '_linkCandidatesErr' as const, userId, error: reply.error }),
            (error) => ({ type: '_linkCandidatesErr' as const, userId, error: String(error) }),
          )
        }
        return { state }
      },

      _linkCandidatesDone: (state, msg, context) => {
        if (!state.llmRef || state.active[msg.userId] || msg.candidates.length === 0) return { state }
        const turns = state.latestTurns[msg.userId] ?? []
        return { state: startUserRequest(msg.userId, turns, msg.candidates, state.llmRef, state, context) }
      },

      _linkCandidatesErr: (state, msg, context) => {
        context.log.warn('memory consolidation candidate selection failed', { userId: msg.userId, error: msg.error })
        return { state }
      },

      _llmProvider: (state, msg) => ({
        state: { ...state, llmRef: msg.ref, active: {} },
      }),

      llmChunk: (state, msg) => {
        const entry = Object.values(state.active).find(active => active.requestId === msg.requestId)
        if (!entry) return { state }
        return {
          state: {
            ...state,
            active: {
              ...state.active,
              [entry.userId]: { ...entry, accumulated: entry.accumulated + msg.text },
            },
          },
        }
      },

      llmReasoningChunk: (state) => ({ state }),

      llmToolCalls: (state, msg, context) => {
        const entry = Object.values(state.active).find(active => active.requestId === msg.requestId)
        if (entry) context.log.warn('memory consolidation ignored unexpected tool calls', { userId: entry.userId })
        return { state }
      },

      llmDone: (state, msg, context) => {
        const entry = Object.values(state.active).find(active => active.requestId === msg.requestId)
        if (!entry) return { state }
        const links = parseLinks(entry.accumulated, entry.candidates)
        const { [entry.userId]: _, ...active } = state.active
        const nextState = { ...state, active }

        if (links.length === 0) {
          context.log.info('memory consolidation produced no links', { userId: entry.userId })
          return { state: nextState }
        }

        context.pipeToSelf(
          ask<KgraphMsg, ConceptLinksReply>(
            state.kgraphRef,
            (replyTo) => ({ type: 'linkConcepts', userId: entry.userId, links, replyTo }),
          ),
          (reply) => reply.type === 'conceptLinksResult'
            ? ({ type: '_linksWritten' as const, userId: entry.userId, linked: reply.linked })
            : ({ type: '_linksWriteErr' as const, userId: entry.userId, error: reply.error }),
          (error) => ({ type: '_linksWriteErr' as const, userId: entry.userId, error: String(error) }),
        )
        return { state: nextState }
      },

      llmError: (state, msg, context) => {
        const entry = Object.values(state.active).find(active => active.requestId === msg.requestId)
        if (!entry) return { state }
        context.log.error('memory consolidation LLM error', { userId: entry.userId, error: String(msg.error) })
        const { [entry.userId]: _, ...active } = state.active
        return { state: { ...state, active } }
      },

      _linksWritten: (state, msg, context) => {
        context.log.info('memory consolidation links written', { userId: msg.userId, linked: msg.linked })
        return { state }
      },

      _linksWriteErr: (state, msg, context) => {
        context.log.error('memory consolidation link write failed', { userId: msg.userId, error: msg.error })
        return { state }
      },
    }),
  }
}
