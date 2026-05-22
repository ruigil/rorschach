import type { ActorDef, ActorRef } from '../../system/types.ts'
import { onLifecycle, onMessage } from '../../system/match.ts'
import type {
  ApiMessage,
  LlmProviderMsg,
  LlmProviderReply,
} from '../../types/llm.ts'
import { LlmProviderTopic } from '../../types/llm.ts'
import type { UserContextMsg } from './types.ts'
import { UserContextTopic } from './types.ts'
import { UserStreamTopic, type UserStreamEvent } from '../../types/events.ts'
import { ContextSnapshotTopic } from '../../types/agents.ts'

// ─── Options ───

export type UserContextOptions = {
  model:         string
  intervalMs:    number
  contextPath?:  string
}

// ─── Internal types ───

type ActiveRequest = {
  requestId:   string
  accumulated: string
  userId:      string
}

export type UserContextState = {
  llmRef:  ActorRef<LlmProviderMsg> | null
  buffers: Record<string, UserStreamEvent[]>
  active:  Record<string, ActiveRequest>   // userId → in-flight LLM request
  userContexts: Record<string, string>      // userId → current context summary
}

// ─── System prompt ───

const buildSystemPrompt = (userId: string, currentContext: string): string =>
  `You are a user model agent for user "${userId}". Your task is to maintain a concise, up-to-date user context summary.\n\n` +
  `## Current Context\n` +
  `${currentContext || '(Empty)'}\n\n` +
  `## Goal\n` +
  `Construct an updated user context summary by incorporating new information from the provided conversation turns.\n\n` +
  `## Rules\n` +
  `1. **Relevance** — Include only the most relevant and meaningful facts about the user (identity, work, goals, preferences, etc.).\n` +
  `2. **Conciseness** — Keep the summary limited in size (maximum 10 paragraphs).\n` +
  `3. **Recency** — When encountering conflicting information, prioritize the most recent data from the turns.\n` +
  `4. **Objectivity** — Be specific and concrete. Do not speculate or pad. Write in third person, present tense.\n` +
  `5. **Output** — Your response MUST be the summary and nothing else. No preamble, no commentary.`

const buildMessages = (userId: string, currentContext: string, turns: UserStreamEvent[]): ApiMessage[] => {
  const turnList = turns.map((t, i) => {
    const date = new Date(t.timestamp).toISOString()
    return `Turn ${i + 1} [${date}]\nUser: ${t.userText}\nAssistant: ${t.assistantText}`
  }).join('\n\n')

  return [
    { role: 'system', content: buildSystemPrompt(userId, currentContext) },
    { role: 'user', content: `Please update the user context based on these new conversation turns:\n\n${turnList}` },
  ]
}

// ─── Actor ───

export const UserContext = (options: UserContextOptions): ActorDef<UserContextMsg, UserContextState> => {
  const { model, intervalMs, contextPath = 'workspace/context' } = options

  const startUserUpdate = (userId: string, turns: UserStreamEvent[], llmRef: ActorRef<LlmProviderMsg>, state: UserContextState, ctx: any): UserContextState => {
    const requestId = crypto.randomUUID()
    const currentContext = state.userContexts[userId] ?? ''

    llmRef.send({
      type: 'stream',
      requestId,
      model,
      messages: buildMessages(userId, currentContext, turns),
      role: 'user-context',
      replyTo: ctx.self as unknown as ActorRef<LlmProviderReply>,
    })

    return {
      ...state,
      active: { ...state.active, [userId]: { requestId, accumulated: '', userId } },
      buffers: { ...state.buffers, [userId]: [] },
    }
  }

  return {
    initialState: INITIAL_USER_CONTEXT_STATE,
    lifecycle: onLifecycle({
      start: (state, context) => {
        context.subscribe(UserStreamTopic, (e) => {
          if (e.injected) return null
          return {
            type: '_turn' as const,
            userId: e.userId,
            userText: e.userText,
            assistantText: e.assistantText,
            timestamp: e.timestamp,
          }
        })
        context.subscribe(LlmProviderTopic, (e) => ({
          type: '_llmProvider' as const,
          ref: e.ref,
        }))
        context.subscribe(ContextSnapshotTopic, (e) => ({
          type: '_contextSnapshot' as const,
          userId: e.userId,
          userContext: e.userContext,
        }))
        context.timers.startPeriodicTimer('user-context-run', { type: '_run' }, intervalMs)
        return { state }
      },
    }),

    handler: onMessage<UserContextMsg, UserContextState>({
      _turn: (state, msg) => {
        const buffer = state.buffers[msg.userId] ?? []
        return {
          state: {
            ...state,
            buffers: {
              ...state.buffers,
              [msg.userId]: [...buffer, { userId: msg.userId, userText: msg.userText, assistantText: msg.assistantText, timestamp: msg.timestamp }],
            },
          },
        }
      },

      _contextSnapshot: (state, msg) => {
        return {
          state: {
            ...state,
            userContexts: {
              ...state.userContexts,
              [msg.userId]: msg.userContext ?? '',
            },
          },
        }
      },

      _run: (state, _, context) => {
        if (!state.llmRef) return { state }

        let next = state
        for (const [userId, turns] of Object.entries(state.buffers)) {
          if (state.active[userId]) continue
          if (turns.length === 0) continue
          next = startUserUpdate(userId, turns, state.llmRef, next, context)
        }

        return { state: next }
      },

      _llmProvider: (state, msg) => ({ state: { ...state, llmRef: msg.ref } }),

      llmChunk: (state, msg) => {
        const entry = Object.values(state.active).find(a => a.requestId === msg.requestId)
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

      llmDone: (state, msg, context) => {
        const entry = Object.values(state.active).find(a => a.requestId === msg.requestId)
        if (!entry) return { state }

        const { userId } = entry
        const summary = entry.accumulated.trim()
        context.log.info('user context updated', { userId, length: summary.length })

        context.publishRetained(UserContextTopic, userId, { userId, summary })

        const { [userId]: _, ...active } = state.active
        const next = {
          ...state,
          active,
          userContexts: {
            ...state.userContexts,
            [userId]: summary,
          },
        }

        // Send a self-message to check if other users have buffered turns that can start now
        context.self.send({ type: '_run' as const })

        return { state: next }
      },

      llmError: (state, msg, context) => {
        const entry = Object.values(state.active).find(a => a.requestId === msg.requestId)
        if (!entry) return { state }
        context.log.error('user context LLM error', { userId: entry.userId, error: String(msg.error) })
        const { [entry.userId]: _, ...active } = state.active
        return { state: { ...state, active } }
      },
    }),
  }
}

const INITIAL_USER_CONTEXT_STATE: UserContextState = {
  llmRef:  null,
  buffers: {},
  active:  {},
  userContexts: {},
}
