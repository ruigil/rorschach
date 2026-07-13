import type { ActorDef, ActorRef } from '../../system/index.ts'
import { onLifecycle, onMessage, ask } from '../../system/index.ts'
import type { MessageAttachment } from '../../types/events.ts'
import type { MemoryRecord, MemoryRecordMeta, MemoryRecordsMsg } from './types.ts'
import { PersistenceProviderTopic, type PersistenceMsg, type PResult } from '../../types/persistence.ts'

type MemoryRecordsState = {
  persistenceRef: ActorRef<any> | null
}

const yamlString = (value: string): string => JSON.stringify(value)

const serializeRecord = (meta: MemoryRecordMeta, content: string): string =>
  `---\n` +
  `recordId: ${yamlString(meta.recordId)}\n` +
  `createdAt: ${yamlString(meta.createdAt)}\n` +
  `${meta.title ? `title: ${yamlString(meta.title)}\n` : ''}` +
  `${meta.attachments && meta.attachments.length > 0 ? `attachments: ${JSON.stringify(meta.attachments)}\n` : ''}` +
  `---\n\n` +
  content

const parseRecord = (raw: string, fallbackRecordId: string): MemoryRecord => {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
  if (!match) {
    return {
      recordId: fallbackRecordId,
      createdAt: '',
      content: raw,
    }
  }

  const frontmatter = match[1]!
  const body = match[2]!.replace(/^\n/, '')
  const getRaw = (key: string): string | undefined => {
    const found = frontmatter.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'))?.[1]?.trim()
    return found || undefined
  }
  const get = (key: string): string | undefined => {
    const found = getRaw(key)
    if (!found) return undefined
    try {
      return JSON.parse(found) as string
    } catch {
      return found
    }
  }
  const attachments = (() => {
    const found = getRaw('attachments')
    if (!found) return undefined
    try {
      const parsed = JSON.parse(found) as unknown
      return Array.isArray(parsed) ? parsed as MessageAttachment[] : undefined
    } catch {
      return undefined
    }
  })()

  return {
    recordId: get('recordId') ?? fallbackRecordId,
    createdAt: get('createdAt') ?? '',
    title: get('title'),
    attachments,
    content: body,
  }
}

const createRecord = async (
  persistenceRef: ActorRef<any>,
  userId: string,
  content: string,
  title?: string,
  attachments?: MessageAttachment[],
): Promise<MemoryRecord> => {
  const meta: MemoryRecordMeta = {
    recordId: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    title: title?.trim() || undefined,
    attachments: attachments && attachments.length > 0 ? attachments : undefined,
  }

  const serialized = serializeRecord(meta, content)
  const docId = `${userId}/${meta.recordId}`
  await ask<PersistenceMsg, PResult>(persistenceRef, (replyTo) => ({
    type: 'doc.put',
    collection: 'memory-records',
    docId,
    content: serialized,
    replyTo,
  }))

  return { ...meta, content }
}

const readRecord = async (persistenceRef: ActorRef<any>, userId: string, recordId: string): Promise<MemoryRecord | null> => {
  try {
    const docId = `${userId}/${recordId}`
    const res = await ask<PersistenceMsg, PResult<string>>(persistenceRef, (replyTo) => ({
      type: 'doc.get',
      collection: 'memory-records',
      docId,
      replyTo,
    }))
    if (res.ok && res.data) return parseRecord(res.data, recordId)
    return null
  } catch {
    return null
  }
}

const readMany = async (persistenceRef: ActorRef<any>, userId: string, recordIds: string[]): Promise<MemoryRecord[]> => {
  const results = await Promise.all(recordIds.map(id => readRecord(persistenceRef, userId, id)))
  return results.filter((r): r is MemoryRecord => r !== null)
}



export const MemoryRecords = (): ActorDef<MemoryRecordsMsg, MemoryRecordsState> => ({
  initialState: () => ({ persistenceRef: null }),

  lifecycle: onLifecycle({
    start: (state, context) => {
      context.subscribe(PersistenceProviderTopic, (event) => ({
        type: '_persistenceRef' as const,
        ref: event.ref,
      }))
      return { state }
    }
  }),

  handler: onMessage<MemoryRecordsMsg, MemoryRecordsState>({
    _persistenceRef: (state, msg) => {
      return { state: { ...state, persistenceRef: msg.ref } }
    },

    create: (state, msg, ctx) => {
      if (!state.persistenceRef) {
        msg.replyTo.send({ error: 'Persistence not ready' })
        return { state }
      }
      ctx.pipeToSelf(
        createRecord(state.persistenceRef, msg.userId, msg.content, msg.title, msg.attachments),
        (record) => ({ type: '_created' as const, replyTo: msg.replyTo, record }),
        (error) => ({ type: '_createErr' as const, replyTo: msg.replyTo, error: String(error) }),
      )
      return { state }
    },

    readMany: (state, msg, ctx) => {
      if (!state.persistenceRef) {
        msg.replyTo.send([])
        return { state }
      }
      ctx.pipeToSelf(
        readMany(state.persistenceRef, msg.userId, msg.recordIds),
        (records) => ({ type: '_readManyDone' as const, replyTo: msg.replyTo, records }),
        (error) => ({ type: '_readManyErr' as const, replyTo: msg.replyTo, error: String(error) }),
      )
      return { state }
    },

    _created: (state, msg) => {
      msg.replyTo.send(msg.record)
      return { state }
    },

    _createErr: (state, msg) => {
      msg.replyTo.send({ error: msg.error })
      return { state }
    },

    _readManyDone: (state, msg) => {
      msg.replyTo.send(msg.records)
      return { state }
    },

    _readManyErr: (state, msg) => {
      msg.replyTo.send([])
      return { state }
    },
  }),
})
