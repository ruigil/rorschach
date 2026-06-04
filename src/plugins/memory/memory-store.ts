import type { ActorDef, ActorContext, ActorRef, ActorResult } from '../../system/index.ts'
import { ask, onMessage, defineTool, parseToolArgs } from '../../system/index.ts'
import type { ToolReply } from '../../types/tools.ts'
import type { LlmProviderMsg, LlmProviderReply } from '../../types/llm.ts'
import type { MessageAttachment, MessageAttachmentKind } from '../../types/events.ts'
import {
  MEMORY_CONCEPT_KINDS,
  MEMORY_LINK_TYPES,
  type ConceptLinksReply,
  type ConceptUpsertReply,
  type KgraphMsg,
  type MemoryConcept,
  type MemoryConceptKind,
  type MemoryConceptLink,
  type MemoryLinkType,
  type MemoryRecord,
  type MemoryRecordsMsg,
  type MemoryStoreMsg,
  type MemorySupervisorMsg,
} from './types.ts'
import { conceptExtractionPrompt } from './ontology.ts'

export const memoryStoreTool = defineTool('store_memory', 'Store a markdown memory record verbatim, then derive concept nodes for semantic recall. Use when the user shares a fact, preference, goal, decision, or note they want remembered.', {
  type: 'object',
  properties: {
    content: { type: 'string', description: 'Markdown content to preserve verbatim as the physical memory record.' },
    topic:   { type: 'string', description: 'Optional topic hint for derived metadata.' },
    attachments: {
      type: 'array',
      description: 'Optional attachment metadata to preserve with the memory record. Base64 data is ignored.',
      items: {
        type: 'object',
        properties: {
          kind:     { type: 'string', enum: ['image', 'audio', 'video', 'pdf', 'file'] },
          url:      { type: 'string' },
          name:     { type: 'string' },
          alt:      { type: 'string' },
          mimeType: { type: 'string' },
        },
        required: ['kind', 'url'],
      },
    },
  },
  required: ['content'],
})

type ExtractionResult = {
  title?: string
  concepts?: MemoryConcept[]
  links?: MemoryConceptLink[]
}

export type MemoryStoreWorkerOptions = {
  model:        string
  maxToolLoops: number
  recordsRef:   ActorRef<MemoryRecordsMsg>
  kgraphRef:    ActorRef<KgraphMsg>
  llmRef:       ActorRef<LlmProviderMsg>
}

export type MemoryStoreWorkerState = {
  replyTo:         ActorRef<ToolReply> | null
  recordsRef:      ActorRef<MemoryRecordsMsg>
  kgraphRef:       ActorRef<KgraphMsg>
  record:          MemoryRecord | null
  accumulatedText: string
  userId:          string
  clientId?:       string
}

const parseExtraction = (text: string): ExtractionResult => {
  const trimmed = text.trim()
  const raw = trimmed.startsWith('```')
    ? trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
    : trimmed
  const parsed = JSON.parse(raw) as Record<string, unknown>
  return {
    title: typeof parsed.title === 'string' ? parsed.title : undefined,
    concepts: Array.isArray(parsed.concepts)
      ? parsed.concepts.map(normalizeConcept).filter((c): c is MemoryConcept => c !== null)
      : [],
    links: Array.isArray(parsed.links)
      ? parsed.links.map(normalizeLink).filter((l): l is MemoryConceptLink => l !== null)
      : [],
  }
}

const stringArray = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.map(v => typeof v === 'string' ? v.trim() : '').filter(Boolean)
    : []

const normalizedKind = (value: unknown): MemoryConceptKind =>
  typeof value === 'string' && (MEMORY_CONCEPT_KINDS as readonly string[]).includes(value)
    ? value as MemoryConceptKind
    : 'fact'

const normalizedLinkType = (value: unknown): MemoryLinkType | null => {
  if (typeof value !== 'string') return null
  const type = value.trim().toUpperCase()
  return (MEMORY_LINK_TYPES as readonly string[]).includes(type) ? type as MemoryLinkType : null
}

const ATTACHMENT_KINDS: MessageAttachmentKind[] = ['image', 'audio', 'video', 'pdf', 'file']

const normalizeAttachment = (value: unknown): MessageAttachment | null => {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const kind = typeof raw.kind === 'string' && (ATTACHMENT_KINDS as string[]).includes(raw.kind)
    ? raw.kind as MessageAttachmentKind
    : null
  const url = typeof raw.url === 'string' ? raw.url : ''
  if (!kind || !url) return null
  const attachment: MessageAttachment = { kind, url }
  if (typeof raw.name === 'string') attachment.name = raw.name
  if (typeof raw.alt === 'string') attachment.alt = raw.alt
  if (typeof raw.mimeType === 'string') attachment.mimeType = raw.mimeType
  return attachment
}

const normalizeAttachments = (value: unknown): MessageAttachment[] | undefined => {
  if (!Array.isArray(value)) return undefined
  const attachments = value.map(normalizeAttachment).filter((a): a is MessageAttachment => a !== null)
  return attachments.length > 0 ? attachments : undefined
}

const normalizeConcept = (value: unknown): MemoryConcept | null => {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const name = typeof raw.name === 'string' ? raw.name.trim() : ''
  const description = typeof raw.description === 'string' ? raw.description.trim() : ''
  if (!name || !description) return null
  return {
    name,
    kind: normalizedKind(raw.kind),
    description,
    topics: Array.from(new Set(stringArray(raw.topics).map(t => t.toLowerCase()))),
    aliases: stringArray(raw.aliases),
    eventTime: typeof raw.eventTime === 'string' && raw.eventTime.trim() ? raw.eventTime.trim() : undefined,
  }
}

const normalizeLink = (value: unknown): MemoryConceptLink | null => {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const from = typeof raw.from === 'string' ? raw.from.trim() : ''
  const to = typeof raw.to === 'string' ? raw.to.trim() : ''
  const type = normalizedLinkType(raw.type)
  if (!from || !to || !type) return null
  const confidence = typeof raw.confidence === 'number' && Number.isFinite(raw.confidence)
    ? Math.max(0, Math.min(1, raw.confidence))
    : undefined
  return {
    from,
    to,
    type,
    confidence,
  }
}

const upsertConcept = async (
  kgraphRef: ActorRef<KgraphMsg>,
  userId: string,
  recordId: string,
  concept: MemoryConcept,
): Promise<number | null> => {
  const reply = await ask<KgraphMsg, ConceptUpsertReply>(
    kgraphRef,
    (replyTo) => ({ type: 'upsertConcept', concept, recordId, userId, replyTo }),
  )
  if (reply.type !== 'conceptUpsertResult') throw new Error(reply.error)
  return reply.nodeId
}

const linkConcepts = async (
  kgraphRef: ActorRef<KgraphMsg>,
  userId: string,
  links: MemoryConceptLink[],
): Promise<number> => {
  const reply = await ask<KgraphMsg, ConceptLinksReply>(
    kgraphRef,
    (replyTo) => ({ type: 'linkConcepts', links, userId, replyTo }),
  )
  if (reply.type !== 'conceptLinksResult') throw new Error(reply.error)
  return reply.linked
}

const indexRecord = async (
  recordsRef: ActorRef<MemoryRecordsMsg>,
  kgraphRef: ActorRef<KgraphMsg>,
  userId: string,
  record: MemoryRecord,
  extractionText: string,
): Promise<{ indexedConcepts: number; warnings: string[] }> => {
  const warnings: string[] = []
  let extraction: ExtractionResult
  try {
    extraction = parseExtraction(extractionText)
  } catch (error) {
    return { indexedConcepts: 0, warnings: [`concept extraction JSON could not be parsed: ${String(error)}`] }
  }

  let indexedConcepts = 0
  for (const concept of extraction.concepts ?? []) {
    try {
      await upsertConcept(kgraphRef, userId, record.recordId, concept)
      indexedConcepts++
    } catch (error) {
      warnings.push(`concept "${concept.name}" was not indexed: ${String(error)}`)
    }
  }

  try {
    await linkConcepts(kgraphRef, userId, extraction.links ?? [])
  } catch (error) {
    warnings.push(`some concept links were not written: ${String(error)}`)
  }

  return { indexedConcepts, warnings }
}

export const MemoryStoreWorker = (parent: ActorRef<MemorySupervisorMsg>, options: MemoryStoreWorkerOptions): ActorDef<MemoryStoreMsg, MemoryStoreWorkerState> => {
  return {
    initialState: () => ({
      replyTo: null,
      recordsRef: options.recordsRef,
      kgraphRef: options.kgraphRef,
      record: null,
      accumulatedText: '',
      userId: '',
    }),

    handler: onMessage<MemoryStoreMsg, MemoryStoreWorkerState>({
      invoke: (state, msg, ctx) => {
        const parsed = parseToolArgs<{ content: string; topic?: string; attachments?: MessageAttachment[] }>(
          msg.arguments,
          (p) => {
            const content = typeof p.content === 'string' ? p.content : ''
            const topic = typeof p.topic === 'string' ? p.topic : undefined
            const attachments = normalizeAttachments(p.attachments)
            return content ? { content, topic, attachments } : null
          },
          'Missing content argument',
        )
        if (!parsed.ok) {
          msg.replyTo.send({ type: 'toolError', error: parsed.error })
          parent.send({ type: '_workerDone', worker: { name: ctx.self.name } })
          return { state }
        }

        ctx.pipeToSelf(
          ask<MemoryRecordsMsg, MemoryRecord | { error: string }>(
            state.recordsRef,
            (replyTo) => ({ type: 'create', content: parsed.value.content, attachments: parsed.value.attachments, userId: msg.userId, replyTo }),
          ),
          (record) => 'error' in record
            ? ({ type: '_recordStoreErr' as const, replyTo: msg.replyTo, error: record.error })
            : ({ type: '_recordStored' as const, replyTo: msg.replyTo, record, topic: parsed.value.topic, userId: msg.userId, clientId: msg.clientId }),
          (error) => ({ type: '_recordStoreErr' as const, replyTo: msg.replyTo, error: String(error) }),
        )
        return { state: { ...state, userId: msg.userId, clientId: msg.clientId } }
      },

      _recordStored: (state, msg, ctx) => {
        const requestId = crypto.randomUUID()
        options.llmRef.send({
          type: 'stream',
          requestId,
          model: options.model,
          messages: [
            { role: 'system', content: conceptExtractionPrompt(msg.userId, msg.topic) },
            { role: 'user', content: msg.record.content },
          ],
          role: 'memory-store',
          clientId: msg.clientId,
          replyTo: ctx.self as unknown as ActorRef<LlmProviderReply>,
        })

        return {
          state: {
            ...state,
            replyTo: msg.replyTo,
            record: msg.record,
          },
        }
      },

      _recordStoreErr: (state, msg, ctx) => {
        msg.replyTo.send({ type: 'toolError', error: msg.error })
        parent.send({ type: '_workerDone', worker: { name: ctx.self.name } })
        return { state }
      },

      llmChunk: (state, msg) => {
        return {
          state: {
            ...state,
            accumulatedText: state.accumulatedText + msg.text,
          },
        }
      },

      llmReasoningChunk: (state) => ({ state }),

      llmToolCalls: (state, _msg, ctx) => {
        ctx.log.warn('memory store ignored unexpected tool calls')
        return { state }
      },

      llmImageChunk: (state) => ({ state }),

      llmDone: (state, _msg, ctx) => {
        const record = state.record
        if (!record || !state.replyTo) {
          parent.send({ type: '_workerDone', worker: { name: ctx.self.name } })
          return { state }
        }

        ctx.pipeToSelf(
          indexRecord(state.recordsRef, state.kgraphRef, state.userId, record, state.accumulatedText),
          (result) => ({
            type: '_indexed' as const,
            summary: JSON.stringify({
              recordId: record.recordId,
              stored: true,
              indexedConcepts: result.indexedConcepts,
              warnings: result.warnings,
            }),
          }),
          (error) => ({ type: '_indexErr' as const, error: String(error) }),
        )
        return { state }
      },

      llmError: (state, msg, ctx) => {
        if (state.record && state.replyTo) {
          state.replyTo.send({
            type: 'toolResult',
            result: {
              text: JSON.stringify({
                recordId: state.record.recordId,
                stored: true,
                indexedConcepts: 0,
                warnings: [`concept extraction failed: ${String(msg.error)}`],
              }),
            },
          })
        } else {
          state.replyTo?.send({ type: 'toolError', error: String(msg.error) })
        }
        parent.send({ type: '_workerDone', worker: { name: ctx.self.name } })
        return { state }
      },

      _indexed: (state, msg, ctx) => {
        state.replyTo?.send({ type: 'toolResult', result: { text: msg.summary } })
        parent.send({ type: '_workerDone', worker: { name: ctx.self.name } })
        return { state }
      },

      _indexErr: (state, msg, ctx) => {
        const record = state.record
        state.replyTo?.send({
          type: 'toolResult',
          result: {
            text: JSON.stringify({
              recordId: record?.recordId,
              stored: true,
              indexedConcepts: 0,
              warnings: [`concept indexing failed: ${msg.error}`],
            }),
          },
        })
        parent.send({ type: '_workerDone', worker: { name: ctx.self.name } })
        return { state }
      },
    }),
  }
}
