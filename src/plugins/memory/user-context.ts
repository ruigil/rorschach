import type { ActorDef, ActorRef, MessageHandler, ActorResult } from '../../system/types.ts'
import { onLifecycle, onMessage } from '../../system/match.ts'
import type {
  ApiMessage,
  LlmProviderMsg,
  LlmProviderReply,
} from '../../types/llm.ts'
import { LlmProviderTopic } from '../../types/llm.ts'
import type { UserContextMsg, UserContextWorkerMsg } from './types.ts'
import { UserContextTopic } from '../../types/memory.ts'
import { UserStreamTopic, type UserStreamEvent } from '../../types/events.ts'

// ─── Options ───

export type UserContextOptions = {
  model:         string
  intervalMs:    number
}

type WorkerOptions = {
  model:            string
  userId:           string
  llmRef:           ActorRef<LlmProviderMsg>
  turns:            UserStreamEvent[]
}

// ─── Internal types ───

export type UserContextState = {
  llmRef:  ActorRef<LlmProviderMsg> | null
  buffers: Record<string, UserStreamEvent[]>
  workers: Record<string, ActorRef<UserContextWorkerMsg>>
}

type WorkerState = {
  requestId:      string | null
  accumulated:    string
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

// ─── Worker Actor ───

const UserContextWorker = (options: WorkerOptions): ActorDef<UserContextWorkerMsg, WorkerState> => {
  const { model, userId, llmRef, turns } = options

  return {
    initialState: { requestId: null, accumulated: '' },
    handler: onMessage<UserContextWorkerMsg, WorkerState>({
      _start: (state, _, context) => {
        context.pipeToSelf(
          (async () => {
            try {
              return await Bun.file(`workspace/memory/${userId}/context.md`).text()
            } catch {
              return ''
            }
          })(),
          (content) => {
            const requestId = crypto.randomUUID()
            llmRef.send({
              type: 'stream',
              requestId,
              model,
              messages: buildMessages(userId, content, turns),
              role: 'user-context',
              replyTo: context.self as unknown as ActorRef<LlmProviderReply>,
            })
            // Return a dummy chunk to initialize requestId in state
            return { type: 'llmChunk' as const, requestId, text: '', done: false }
          },
          (error) => {
            context.log.error('user context worker: failed to read context file', { userId, error: String(error) })
            return { type: '_stop' as const }
          }
        )
        return { state }
      },

      llmChunk: (state, msg) => {
        if (state.requestId !== null && msg.requestId !== state.requestId) return { state }
        return { state: { ...state, requestId: msg.requestId, accumulated: state.accumulated + msg.text } }
      },

      llmReasoningChunk: (state) => ({ state }),

      llmDone: (state, msg, context) => {
        if (msg.requestId !== state.requestId) return { state }
        const summary = state.accumulated.trim()
        context.log.info('user context updated', { userId, length: summary.length })

        context.publishRetained(UserContextTopic, userId, { userId, summary })

        context.pipeToSelf(
          Bun.write(`workspace/memory/${userId}/context.md`, summary),
          () => {
            context.log.info('user context saved', { userId })
            return { type: '_stop' as const }
          },
          (error) => {
            context.log.error('user context save failed', { userId, error: String(error) })
            return { type: '_stop' as const }
          }
        )
        return { state }
      },

      llmError: (state, msg, context) => {
        if (msg.requestId !== state.requestId) return { state }
        context.log.error('user context LLM error', { userId, error: String(msg.error) })
        return { state, become: (s, m, c) => { c.stop(c.self); return { state: s } } } // Quick stop
      },

      _stop: (state, _, context) => {
        context.stop(context.self)
        return { state }
      },
    }),
  }
}

// ─── Supervisor Actor ───

export const UserContextSupervisor = (options: UserContextOptions): ActorDef<UserContextMsg, UserContextState> => {
  const { model, intervalMs } = options

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
        context.timers.startPeriodicTimer('user-context-run', { type: '_run' }, intervalMs)
        return { state }
      },
      terminated: (state, event) => {
        const entry = Object.entries(state.workers).find(([, ref]) => ref.name === event.ref.name)
        if (!entry) return { state }
        const [userId] = entry
        const { [userId]: _, ...workers } = state.workers
        return { state: { ...state, workers } }
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

      _run: (state, _, context) => {
        if (!state.llmRef) return { state }

        const workers = { ...state.workers }
        const buffers = { ...state.buffers }

        for (const [userId, turns] of Object.entries(buffers)) {
          if (workers[userId]) continue // Already running for this user
          if (turns.length === 0) continue

          const worker = context.spawn(
            `user-context-worker-${userId}`,
            UserContextWorker({ model, userId, llmRef: state.llmRef, turns }),
          )
          worker.send({ type: '_start' })
          workers[userId] = worker
          buffers[userId] = []
        }

        return { state: { ...state, workers, buffers } }
      },

      _llmProvider: (state, msg) => ({ state: { ...state, llmRef: msg.ref } }),

      _workerDone: (state) => ({ state }),
    }),
  }
}

export const INITIAL_USER_CONTEXT_STATE: UserContextState = {
  llmRef:  null,
  buffers: {},
  workers: {},
}
