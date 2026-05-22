import type { ActorContext, ActorDef, ActorRef, Interceptor } from '../../system/index.ts'
import { agentLoop, idleLoopState, type LoopState } from '../../system/index.ts'
import { onLifecycle, onMessage } from '../../system/index.ts'
import { UserStreamTopic } from '../../types/events.ts'
import type { UserStreamEvent } from '../../types/events.ts'
import type { ToolCollection } from '../../types/tools.ts'
import type {
  ApiMessage,
  LlmProviderMsg,
} from '../../types/llm.ts'
import { LlmProviderTopic } from '../../types/llm.ts'
import type { MemoryConsolidationMsg, UserConsolidationWorkerMsg } from './types.ts'
import { zettelConsolidationSection } from './ontology.ts'

// ─── Options ───

export type MemoryConsolidationOptions = {
  model:         string
  intervalMs:    number
  tools:         ToolCollection
  maxToolLoops?: number
}

type WorkerOptions = {
  model:            string
  userId:           string
  llmRef:           ActorRef<LlmProviderMsg>
  tools:            ToolCollection
  maxToolLoops?:    number
}

// ─── Worker State ───

type ConsolidationWorkerState = {
  loop:    LoopState
  userId:  string
  buffer:  UserStreamEvent[]
  llmRef:  ActorRef<LlmProviderMsg> | null
  tools:   ToolCollection
}

const initialConsolidationWorkerState = (
  userId: string,
  llmRef: ActorRef<LlmProviderMsg>,
  tools: ToolCollection,
): ConsolidationWorkerState => ({
  loop: idleLoopState(),
  userId,
  buffer: [],
  llmRef,
  tools,
})

// ─── System prompt ───

const buildSystemPrompt = (userId: string): string =>
  `You are a user model agent for user "${userId}".\n\n` +
  `## Primary Goal\n` +
  `Build a network of relationships between existing atomic notes about this user.\n\n` +
  zettelConsolidationSection(userId) +
  `Skip trivial exchanges. Focus on discovering non-obvious links that connect concepts across the conversation history.`

const buildMessages = (userId: string, turns: UserStreamEvent[]): ApiMessage[] => {
  const turnList = turns.map((t, i) => {
    const date = new Date(t.timestamp).toISOString()
    return `Turn ${i + 1} [${date}]\nUser: ${t.userText}\nAssistant: ${t.assistantText}`
  }).join('\n\n')
  return [
    { role: 'system', content: buildSystemPrompt(userId) },
    { role: 'user', content: `Please consolidate these conversation turns into memory:\n\n${turnList}` },
  ]
}

// ─── Worker actor: one per user, persistent ───

const ConsolidationWorker = (options: WorkerOptions): ActorDef<UserConsolidationWorkerMsg, ConsolidationWorkerState> => {
  const { model, userId, llmRef, tools, maxToolLoops = 25 } = options

  const loop = agentLoop<ConsolidationWorkerState, UserConsolidationWorkerMsg>({
    role:         'memory-consolidation',
    spanName:     'memory-consolidation',
    logPrefix:    'memory consolidation',
    model,
    maxToolLoops,
    llmRef:       (s) => s.llmRef,
    tools:        (s) => s.tools,

    onComplete: (state, finalText, _usage, ctx) => {
      ctx.log.info('memory consolidation done', { userId: state.userId, chars: finalText.length })
      return { state }
    },

    onError: (state, err, ctx) => {
      if (err.kind === 'llm') {
        ctx.log.error('memory consolidation LLM error', { userId: state.userId, error: String(err.error) })
      } else {
        ctx.log.warn('memory consolidation tool loop limit reached', { userId: state.userId, limit: err.limit })
      }
      return { state }
    },
  })

  const hostInterceptor: Interceptor<UserConsolidationWorkerMsg, ConsolidationWorkerState> = (state, msg, ctx, next) => {
    const m = msg as UserConsolidationWorkerMsg

    if (m.type === '_turn') {
      return {
        state: {
          ...state,
          buffer: [
            ...state.buffer,
            { userId: state.userId, userText: m.userText, assistantText: m.assistantText, timestamp: m.timestamp },
          ],
        },
      }
    }

    if (m.type === '_consolidate') {
      if (state.loop.phase !== 'idle') return { state }
      if (state.buffer.length === 0) return { state }

      const snapshotTurns = state.buffer
      const messages      = buildMessages(state.userId, snapshotTurns)
      const requestSpan   = ctx.trace.start('memory-consolidation', { userId: state.userId, turns: snapshotTurns.length })

      ctx.log.info('memory consolidation started', { userId: state.userId, turns: snapshotTurns.length })

      return loop.startTurn(
        { ...state, buffer: [] },
        { messages, userId: state.userId, requestSpan },
        ctx,
      )
    }

    return next(state, msg)
  }

  return {
    initialState: initialConsolidationWorkerState(userId, llmRef, tools),
    handler:      loop.idle,
    interceptors: [hostInterceptor],
  }
}

// ─── Supervisor actor: routes turns to per-user workers ───

export type ConsolidationState = {
  llmRef:           ActorRef<LlmProviderMsg> | null
  tools:            ToolCollection
  workers:          Record<string, ActorRef<UserConsolidationWorkerMsg>>
  workerSeq:        number
}

export const MemoryConsolidation = (options: MemoryConsolidationOptions): ActorDef<MemoryConsolidationMsg, ConsolidationState> => {
  const { model, intervalMs, tools, maxToolLoops } = options

  const stopAllWorkers = (state:   ConsolidationState, context: ActorContext<MemoryConsolidationMsg> ): ConsolidationState => {
    for (const ref of Object.values(state.workers)) context.stop(ref)
    return { ...state, workers: {} }
  }

  return {
    initialState: {
      llmRef:    null,
      tools,
      workers:   {},
      workerSeq: 0,
    },
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
        context.timers.startPeriodicTimer('consolidation', { type: '_consolidate' }, intervalMs)
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

    handler: onMessage<MemoryConsolidationMsg, ConsolidationState>({
      _turn: (state, msg, context) => {
        let worker    = state.workers[msg.userId]
        let workers   = state.workers
        let workerSeq = state.workerSeq

        if (!worker) {
          if (state.llmRef === null) return { state }
          workerSeq = workerSeq + 1
          worker = context.spawn(
            `consolidation-user-${msg.userId}-${workerSeq}`,
            ConsolidationWorker({
              model,
              userId:           msg.userId,
              llmRef:           state.llmRef,
              tools:            state.tools,
              maxToolLoops,
            }),
          )
          workers = { ...workers, [msg.userId]: worker }
        }

        worker.send({
          type:          '_turn',
          userText:      msg.userText,
          assistantText: msg.assistantText,
          timestamp:     msg.timestamp,
        })

        return { state: { ...state, workers, workerSeq } }
      },

      _consolidate: (state) => {
        for (const ref of Object.values(state.workers)) {
          ref.send({ type: '_consolidate' })
        }
        return { state }
      },

      _llmProvider: (state, msg, context) => {
        const updated = { ...state, llmRef: msg.ref }
        return { state: stopAllWorkers(updated, context) }
      },
    }),
  }
}
