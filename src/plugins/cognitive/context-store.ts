import type { ActorDef, PersistenceAdapter } from '../../system/index.ts'
import { onLifecycle, onMessage } from '../../system/index.ts'
import type { ApiMessage } from '../../types/llm.ts'
import { UserContextTopic } from './types.ts'
import {
  ContextSnapshotTopic,
  type AgentContextMsg,
  type ContextRecordSource,
  type ContextTurn,
  type ToolSummary,
} from '../../types/agents.ts'

// ─── Message protocol ───

export type ContextStoreMsg =
  | AgentContextMsg
  | { type: 'setUserContext'; summary: string | null }

// ─── State ───

const CONTEXT_SCHEMA_VERSION = 2

type ContextRecord = {
  message:   ApiMessage
  timestamp: number
  mode:      string
  source:    ContextRecordSource
  clientId?: string
  injected?: boolean
}

export type ContextStoreState = {
  schemaVersion:      number
  records:            ContextRecord[]
  turns:              ContextTurn[]
  nextTurnSeq:        number
  userContext:        string | null
  modeSummaries:      Record<string, string>
  version:            number
  pendingUserText:    string | null    // ephemeral — not persisted
  pendingUserInjected: boolean         // ephemeral — not persisted
}

const initialContextStoreState = (): ContextStoreState => ({
  schemaVersion:       CONTEXT_SCHEMA_VERSION,
  records:             [],
  turns:               [],
  nextTurnSeq:         1,
  userContext:         null,
  modeSummaries:       {},
  version:             0,
  pendingUserText:     null,
  pendingUserInjected: false,
})

// ─── Options ───

export type ContextStoreOptions = {
  userId:              string
  contextWindowHours?: number   // when set, trim context records older than the window on each append
  contextPath?:        string
}

// ─── On-disk format ───

type PersistedContextStore = {
  schemaVersion: number
  userContext:   string | null
  modeSummaries: Record<string, string>
  records:       ContextRecord[]
  turns:         ContextTurn[]
  nextTurnSeq:   number
}

const createPersistence = (userId: string, contextPath: string = 'workspace/context'): PersistenceAdapter<ContextStoreState> => {
  const path = `${contextPath}/context-${userId}.json`

  return {
    load: async () => {
      const file = Bun.file(path)
      if (!await file.exists()) return undefined
      let saved: PersistedContextStore
      try {
        saved = JSON.parse(await file.text()) as PersistedContextStore
      } catch {
        return undefined
      }
      if (
        saved.schemaVersion !== CONTEXT_SCHEMA_VERSION ||
        !Array.isArray(saved.records) ||
        !Array.isArray(saved.turns) ||
        typeof saved.nextTurnSeq !== 'number'
      ) return undefined
      return {
        schemaVersion: CONTEXT_SCHEMA_VERSION,
        records:       saved.records,
        turns:         saved.turns,
        nextTurnSeq:   saved.nextTurnSeq,
        userContext:   saved.userContext ?? null,
        modeSummaries: saved.modeSummaries ?? {},
        version:       0,
        pendingUserText:     null,
        pendingUserInjected: false,
      }
    },
    save: async (state) => {
      const data: PersistedContextStore = {
        schemaVersion: CONTEXT_SCHEMA_VERSION,
        userContext:   state.userContext,
        modeSummaries: state.modeSummaries,
        records:       state.records,
        turns:         state.turns,
        nextTurnSeq:   state.nextTurnSeq,
      }
      await Bun.write(path, JSON.stringify(data, null, 2))
    },
  }
}

// ─── Helpers ───

const sourceForMessage = (message: ApiMessage, fallback?: ContextRecordSource): ContextRecordSource => {
  if (message.role === 'tool') return 'tool'
  if (message.role === 'assistant') return 'assistant'
  if (message.role === 'user') return 'user'
  return fallback ?? 'assistant'
}

const trimRecords = (records: ContextRecord[], hours: number): ContextRecord[] => {
  const cutoff = Date.now() - hours * 60 * 60 * 1000
  let earliestValidIndex = records.length
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i]!
    if (r.timestamp < cutoff) break
    if (r.message.role === 'user') earliestValidIndex = i
  }
  return records.slice(earliestValidIndex)
}

const trimTurns = (turns: ContextTurn[], hours: number): ContextTurn[] => {
  const cutoff = Date.now() - hours * 60 * 60 * 1000
  return turns.filter(turn => turn.timestamp >= cutoff)
}

const extractText = (message: ApiMessage): string =>
  typeof message.content === 'string' ? message.content : ''

const isConversationMessage = (message: ApiMessage): boolean => {
  if (message.role === 'user') return true
  if (message.role === 'assistant') return typeof message.content === 'string' && !message.tool_calls?.length
  return false
}

const toRecentMessages = (records: ContextRecord[]): ApiMessage[] =>
  records
    .map(r => r.message)
    .filter(isConversationMessage)

const truncate = (text: string, limit = 500): string =>
  text.length > limit ? `${text.slice(0, limit).trimEnd()}...` : text

const buildToolSummaries = (records: ContextRecord[]): ToolSummary[] => {
  const toolNames = new Map<string, string>()
  const summaries: ToolSummary[] = []

  for (const record of records) {
    const message = record.message
    if (message.role === 'assistant' && message.tool_calls?.length) {
      for (const call of message.tool_calls) {
        toolNames.set(call.id, call.function.name)
      }
      continue
    }

    if (message.role !== 'tool') continue
    const toolName = toolNames.get(message.tool_call_id) ?? 'tool'
    summaries.push({
      mode:      record.mode,
      toolName,
      summary:   truncate(message.content),
      timestamp: record.timestamp,
    })
  }

  return summaries
}

// ─── Actor ───

export const ContextStore = (
  options: ContextStoreOptions,
): ActorDef<ContextStoreMsg, ContextStoreState> => {
  const { userId, contextWindowHours, contextPath } = options

  const publishSnapshot = (state: ContextStoreState, ctx: { publishRetained: any }) => {
    const recentMessages = toRecentMessages(state.records)
    ctx.publishRetained(ContextSnapshotTopic, userId, {
      userId,
      version:       state.version,
      recentMessages,
      turns:         state.turns,
      userContext:   state.userContext,
      modeSummaries: state.modeSummaries,
      toolSummaries: buildToolSummaries(state.records),
    })
  }

  return {
    initialState: initialContextStoreState,
    persistence: createPersistence(userId, contextPath),

    lifecycle: onLifecycle({
      start: (state, ctx) => {
        ctx.subscribe(UserContextTopic, (e) =>
          e.userId === userId
            ? { type: 'setUserContext' as const, summary: e.summary }
            : null,
        )
        // Publish initial snapshot so any agents spawned with this store as a
        // dependency immediately receive it via the retained topic.
        publishSnapshot(state, ctx)
        return { state }
      },
    }),

    handler: onMessage<ContextStoreMsg, ContextStoreState>({
      append: (state, msg, ctx) => {
        // Ignore system-role messages by convention — system prompts are
        // synthesized per-turn and don't belong in shared context.
        const accepted = msg.messages.filter(m => m.role !== 'system')
        if (accepted.length === 0) return { state }

        const now = msg.timestamp ?? Date.now()
        const newRecords: ContextRecord[] = [
          ...state.records,
          ...accepted.map(message => ({
            message,
            timestamp: now,
            mode:      msg.mode,
            source:    sourceForMessage(message, msg.source),
            ...(msg.clientId ? { clientId: msg.clientId } : {}),
            ...(msg.injected !== undefined ? { injected: msg.injected } : {}),
          })),
        ]
        const trimmed = contextWindowHours ? trimRecords(newRecords, contextWindowHours) : newRecords

        // Turn detection: pair user message with assistant reply for context snapshots.
        let pendingUserText    = state.pendingUserText
        let pendingUserInjected = state.pendingUserInjected
        let completedTurn: ContextTurn | null = null

        const lastUser = accepted.findLast(m => m.role === 'user')
        const lastAssistant = accepted.findLast(m => isConversationMessage(m) && m.role === 'assistant')

        if (lastUser && !lastAssistant) {
          pendingUserText = extractText(lastUser)
          pendingUserInjected = msg.injected ?? false
        } else if (lastAssistant && pendingUserText) {
          if (!pendingUserInjected) {
            completedTurn = {
              seq:           state.nextTurnSeq,
              userId,
              userText:      pendingUserText,
              assistantText: extractText(lastAssistant),
              timestamp:     now,
            }
          }
          pendingUserText = null
          pendingUserInjected = false
        }

        const nextTurns = completedTurn
          ? [...state.turns, completedTurn]
          : state.turns
        const trimmedTurns = contextWindowHours ? trimTurns(nextTurns, contextWindowHours) : nextTurns

        const next: ContextStoreState = {
          ...state,
          records: trimmed,
          turns: trimmedTurns,
          nextTurnSeq: completedTurn ? state.nextTurnSeq + 1 : state.nextTurnSeq,
          version: state.version + 1,
          pendingUserText,
          pendingUserInjected,
        }
        publishSnapshot(next, ctx)

        return { state: next }
      },

      setUserContext: (state, msg, ctx) => {
        if (state.userContext === msg.summary) return { state }
        const next: ContextStoreState = {
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
