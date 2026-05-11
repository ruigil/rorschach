import type { ActorDef, PersistenceAdapter } from '../../system/types.ts'
import { onLifecycle, onMessage } from '../../system/match.ts'
import type { ApiMessage } from '../../types/llm.ts'
import { UserContextTopic } from '../../types/memory.ts'
import { HistorySnapshotTopic } from './types.ts'

// ─── Message protocol ───

export type HistoryStoreMsg =
  | { type: 'append';         messages: ApiMessage[] }
  | { type: 'setUserContext'; summary: string | null }
  | { type: '_userContext';   summary: string }      // forwarded from UserContextTopic

// ─── State ───

type Record_ = { message: ApiMessage; timestamp: number }

export type HistoryStoreState = {
  records:     Record_[]
  userContext: string | null
  version:     number
}

const initialHistoryStoreState = (): HistoryStoreState => ({
  records:     [],
  userContext: null,
  version:     0,
})

// ─── Options ───

export type HistoryStoreOptions = {
  userId:              string
  historyWindowHours?: number   // when set, trim records older than the window on each append
}

// ─── On-disk format (backward compatible with chatbot's createPersistence) ───

type PersistedHistoryStore = { userContext: string | null }

const createPersistence = (userId: string): PersistenceAdapter<HistoryStoreState> => {
  const path = `workspace/history/${userId}.json`
  return {
    load: async () => {
      const file = Bun.file(path)
      if (!await file.exists()) return undefined
      const saved = JSON.parse(await file.text()) as PersistedHistoryStore
      return {
        records:     [],
        userContext: saved.userContext ?? null,
        version:     0,
      }
    },
    save: async (state) => {
      const data: PersistedHistoryStore = { userContext: state.userContext }
      await Bun.write(path, JSON.stringify(data, null, 2))
    },
  }
}

// ─── Helpers ───

const trimRecords = (records: Record_[], hours: number): Record_[] => {
  const cutoff = Date.now() - hours * 60 * 60 * 1000
  let earliestValidIndex = records.length
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i]!
    if (r.timestamp < cutoff) break
    if (r.message.role === 'user') earliestValidIndex = i
  }
  return records.slice(earliestValidIndex)
}

const toMessages = (records: Record_[]): ApiMessage[] => records.map(r => r.message)

// ─── Actor ───

export const HistoryStore = (
  options: HistoryStoreOptions,
): ActorDef<HistoryStoreMsg, HistoryStoreState> => {
  const { userId, historyWindowHours } = options

  const publishSnapshot = (state: HistoryStoreState, ctx: { publishRetained: any }) => {
    ctx.publishRetained(HistorySnapshotTopic, userId, {
      userId,
      messages:    toMessages(state.records),
      userContext: state.userContext,
      version:     state.version,
    })
  }

  return {
    initialState: initialHistoryStoreState,
    persistence: createPersistence(userId),

    lifecycle: onLifecycle({
      start: (state, ctx) => {
        ctx.subscribe(UserContextTopic, (e) =>
          e.userId === userId
            ? { type: '_userContext' as const, summary: e.summary }
            : null,
        )
        // Publish initial snapshot so any agents spawned with this store as a
        // dependency immediately receive it via the retained topic.
        publishSnapshot(state, ctx)
        return { state }
      },
    }),

    handler: onMessage<HistoryStoreMsg, HistoryStoreState>({
      append: (state, msg, ctx) => {
        // Ignore system-role messages by convention — system prompts are
        // synthesized per-turn and don't belong in shared history.
        const accepted = msg.messages.filter(m => m.role !== 'system')
        if (accepted.length === 0) return { state }

        const now = Date.now()
        const newRecords: Record_[] = [
          ...state.records,
          ...accepted.map(message => ({ message, timestamp: now })),
        ]
        const trimmed = historyWindowHours ? trimRecords(newRecords, historyWindowHours) : newRecords

        const next: HistoryStoreState = {
          ...state,
          records: trimmed,
          version: state.version + 1,
        }
        publishSnapshot(next, ctx)
        return { state: next }
      },

      setUserContext: (state, msg, ctx) => {
        if (state.userContext === msg.summary) return { state }
        const next: HistoryStoreState = {
          ...state,
          userContext: msg.summary,
          version:     state.version + 1,
        }
        publishSnapshot(next, ctx)
        return { state: next }
      },

      _userContext: (state, msg, ctx) => {
        if (state.userContext === msg.summary) return { state }
        const next: HistoryStoreState = {
          ...state,
          userContext: msg.summary,
          version:     state.version + 1,
        }
        publishSnapshot(next, ctx)
        return { state: next }
      },
    }),

    supervision: { type: 'restart', maxRetries: 3, withinMs: 30_000 },
  }
}
