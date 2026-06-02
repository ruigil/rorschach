import { mkdir } from 'node:fs/promises'
import type { ActorDef } from '../../system/index.ts'
import { onMessage } from '../../system/index.ts'
import type { MemoryRecord, MemoryRecordMeta, MemoryRecordsMsg } from './types.ts'

type MemoryRecordsState = {
  workPath: string
}

const recordsDir = (userId: string, workPath: string): string => `${workPath}/${userId}/records`
const recordPath = (userId: string, recordId: string, workPath: string): string => `${recordsDir(userId, workPath)}/${recordId}.md`

const yamlString = (value: string): string => JSON.stringify(value)

const serializeRecord = (meta: MemoryRecordMeta, content: string): string =>
  `---\n` +
  `recordId: ${yamlString(meta.recordId)}\n` +
  `createdAt: ${yamlString(meta.createdAt)}\n` +
  `${meta.title ? `title: ${yamlString(meta.title)}\n` : ''}` +
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
  const get = (key: string): string | undefined => {
    const found = frontmatter.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'))?.[1]?.trim()
    if (!found) return undefined
    try {
      return JSON.parse(found) as string
    } catch {
      return found
    }
  }

  return {
    recordId: get('recordId') ?? fallbackRecordId,
    createdAt: get('createdAt') ?? '',
    title: get('title'),
    content: body,
  }
}

const createRecord = async (
  userId: string,
  content: string,
  workPath: string,
  title?: string,
): Promise<MemoryRecord> => {
  const meta: MemoryRecordMeta = {
    recordId: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    title: title?.trim() || undefined,
  }

  await mkdir(recordsDir(userId, workPath), { recursive: true })
  await Bun.write(recordPath(userId, meta.recordId, workPath), serializeRecord(meta, content))

  return { ...meta, content }
}

const readRecord = async (userId: string, recordId: string, workPath: string): Promise<MemoryRecord | null> => {
  try {
    const raw = await Bun.file(recordPath(userId, recordId, workPath)).text()
    return parseRecord(raw, recordId)
  } catch {
    return null
  }
}

const readMany = async (userId: string, recordIds: string[], workPath: string): Promise<MemoryRecord[]> => {
  const records = await Promise.all(recordIds.map(recordId => readRecord(userId, recordId, workPath)))
  return records.filter((record): record is MemoryRecord => record !== null)
}

export const MemoryRecords = (workPath: string): ActorDef<MemoryRecordsMsg, MemoryRecordsState> => ({
  initialState: () => ({ workPath }),

  handler: onMessage<MemoryRecordsMsg, MemoryRecordsState>({
    create: (state, msg, ctx) => {
      ctx.pipeToSelf(
        createRecord(msg.userId, msg.content, state.workPath, msg.title),
        (record) => ({ type: '_created' as const, replyTo: msg.replyTo, record }),
        (error) => ({ type: '_createErr' as const, replyTo: msg.replyTo, error: String(error) }),
      )
      return { state }
    },

    readMany: (state, msg, ctx) => {
      ctx.pipeToSelf(
        readMany(msg.userId, msg.recordIds, state.workPath),
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
