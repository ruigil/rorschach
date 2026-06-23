import type { ActorDef, ActorContext, ActorRef, ActorResult, Interceptor } from '../../system/index.ts'
import { onLifecycle, applyToolFilter } from '../../system/index.ts'
import { agentLoop, idleLoopState } from '../../system/index.ts'
import type { ToolCollection, ToolFilter } from '../../types/tools.ts'
import { ToolRegistrationTopic } from '../../types/tools.ts'
import { OutboundUserMessageTopic, type MessageAttachment } from '../../types/events.ts'
import { ContextSnapshotTopic, type AgentFactoryOpts, type AgentModelOptions } from '../../types/agents.ts'
import { assembleAgentMessages, assembleUserText, getTodayDateString, type ContextView } from '../../system/index.ts'
import type { CoachAgentMsg, CoachAgentState } from './types.ts'
import type { ApiMessage } from '../../types/llm.ts'

// ─── Options ───

export type CoachAgentOptions = AgentModelOptions & {
  notebookDir:  string
  tools:        ToolCollection
}

const COACH_MODE = 'coach'

export const COACH_TOOL_FILTER: ToolFilter = {
  allow: [
    'web_search',    // For research on workouts, health guidelines, and study topics
    'cron_create',   // For scheduling daily coaching check-ins and habit reminders
    'cron_delete',   // For cancelling habits/schedules
    'cron_list',     // For viewing active reminders
    'switch_mode',   // For handing the user back to coding or chatbot modes
  ]
}

// ─── Helpers ───

const buildSystemPrompt = (notebookDir: string): string =>
  `You are an encouraging, accountability-focused personal coach for health, learning routines, habit building, writing journal entries, and habit tracking. Today is ${getTodayDateString('iso')}.\n` +
  `You manage and coordinate the user's personal notebook stored at "${notebookDir}".\n\n` +
  `Available notebook areas and tools:\n` +
  `- Journal: daily markdown entries (journal_write, journal_read, journal_search)\n` +
  `- Tracker: habit logging and statistics in CSV (tracker_log, tracker_stats, tracker_define_habit, tracker_list_habits)\n` +
  `- Todos: task list with due dates and recurrence (todos_create, todos_complete, todos_list, todos_delete, todos_update)\n` +
  `- Search: full-text search across journal and todos (notebook_search)\n\n` +
  `You also have dynamic access to global tools if they are registered:\n` +
  `- web_search: Research workouts, health guidelines, study topics, recipes, and more.\n` +
  `- cron_create / cron_delete / cron_list: Schedule daily coaching check-ins and habit reminders (e.g., schedule a daily reminder to check if they completed their Spanish/exercise habit).\n` +
  `- switch_mode: Hand the user back to other modes like coding or chatbot when requested.\n\n` +
  `Coaching guidelines:\n` +
  `1. Be proactive: offer to schedule reminders using cron_create if the user wants to build a new habit.\n` +
  `2. Use tracker_stats and tracker_log to monitor and review user consistency. Encouragingly comment on their stats.\n` +
  `3. Be structured, positive, and supportive. Focus on helping the user stay on track.`

const emptyContextView = (userId = ''): ContextView => ({
  userId,
  version:        0,
  recentMessages: [],
  userContext:    null,
  toolSummaries:  [],
})

// ─── Actor Factory ───

export const CoachAgentFactory = (options: CoachAgentOptions) =>
  (opts: AgentFactoryOpts): ActorDef<CoachAgentMsg, CoachAgentState> => CoachAgent(options, opts)

// ─── Actor Definition ───

export const CoachAgent = (
  options: CoachAgentOptions,
  opts:    AgentFactoryOpts,
): ActorDef<CoachAgentMsg, CoachAgentState> => {
  const { model, maxToolLoops, notebookDir, tools } = options
  const { userId, contextStoreRef, llmRef } = opts

  const initialCoachState = (): CoachAgentState => ({
    loop:        idleLoopState(),
    contextView: emptyContextView(userId),
    tools:       { ...tools },
  })

  const buildTurnMessages = (state: CoachAgentState, userMsg: ApiMessage): ApiMessage[] =>
    assembleAgentMessages(state.contextView, {
      mode:                      COACH_MODE,
      systemPrompt:              buildSystemPrompt(notebookDir),
      includeToolSummaries:      true,
    }, userMsg)

  const loop = agentLoop<CoachAgentState, CoachAgentMsg>({
    role:          'reasoning',
    spanName:      'coach-agent',
    logPrefix:     'coach-agent',
    model,
    maxToolLoops: maxToolLoops ?? 10,
    llmRef:        () => llmRef,
    tools:         (s) => s.tools,

    uiEvents:      OutboundUserMessageTopic,

    onComplete: (state, finalText) => {
      if (finalText) {
        contextStoreRef.send({
          type:     'append',
          mode:     COACH_MODE,
          source:   'assistant',
          messages: [{ role: 'assistant', content: finalText }]
        })
      }
      return { state }
    },

    onBatchHistoryReady: (state, messages) => {
      contextStoreRef.send({ type: 'append', mode: COACH_MODE, messages })
      return { state }
    },

    onToolPending: (state, pending) => {
      const text = pending.placeholderText ?? `Background job started for ${pending.toolName} (jobId=${pending.jobId}).`
      contextStoreRef.send({
        type:     'append',
        mode:     COACH_MODE,
        source:   'assistant',
        messages: [{ role: 'assistant', content: text }],
      })
      return { state }
    },

    onError: (state, err, ctx) => {
      if (err.kind === 'loopLimit') {
        ctx.log.warn('coach-agent: tool loop limit reached')
      }
      return { state }
    },
  })

  const handleContextSnapshot = (state: CoachAgentState, msg: Extract<CoachAgentMsg, { type: '_contextSnapshot' }>): ActorResult<CoachAgentMsg, CoachAgentState> => {
    return {
      state: {
        ...state,
        contextView: {
          userId:         msg.userId,
          version:        msg.version,
          recentMessages: msg.recentMessages,
          userContext:    msg.userContext,
          toolSummaries:  msg.toolSummaries,
        },
      },
    }
  }

  const handleUserMessage = (state: CoachAgentState, msg: Extract<CoachAgentMsg, { type: 'userMessage' }>, ctx: ActorContext<CoachAgentMsg>): ActorResult<CoachAgentMsg, CoachAgentState> => {
    const userText = assembleUserText(msg.text, msg.attachments)
    const userMsg: ApiMessage = { role: 'user', content: userText }
    contextStoreRef.send({
      type:     'append',
      mode:     COACH_MODE,
      source:   'user',
      injected: msg.isInjected || false,
      messages: [userMsg]
    })
    return loop.startTurn(state, {
      messages: buildTurnMessages(state, userMsg),
      userId,
    }, ctx)
  }

  const handleToolRegistered = (state: CoachAgentState, msg: Extract<CoachAgentMsg, { type: '_toolRegistered' }>): ActorResult<CoachAgentMsg, CoachAgentState> => {
    return {
      state: {
        ...state,
        tools: {
          ...state.tools,
          [msg.name]: {
            name:             msg.name,
            schema:           msg.schema,
            ref:              msg.ref,
            mayBeLongRunning: msg.mayBeLongRunning,
          },
        },
      },
    }
  }

  const handleToolUnregistered = (state: CoachAgentState, msg: Extract<CoachAgentMsg, { type: '_toolUnregistered' }>): ActorResult<CoachAgentMsg, CoachAgentState> => {
    const { [msg.name]: _, ...rest } = state.tools
    return {
      state: {
        ...state,
        tools: rest,
      },
    }
  }

  const hostInterceptor: Interceptor<CoachAgentMsg, CoachAgentState> = (state, msg, ctx, next) => {
    const m = msg as CoachAgentMsg

    if (m.type === '_contextSnapshot') {
      return handleContextSnapshot(state, m as Extract<CoachAgentMsg, { type: '_contextSnapshot' }>)
    }

    if (m.type === 'userMessage') {
      if (state.loop.phase !== 'idle') return { state, stash: true }
      return handleUserMessage(state, m as Extract<CoachAgentMsg, { type: 'userMessage' }>, ctx)
    }

    if (m.type === '_toolRegistered') {
      return handleToolRegistered(state, m as Extract<CoachAgentMsg, { type: '_toolRegistered' }>)
    }

    if (m.type === '_toolUnregistered') {
      return handleToolUnregistered(state, m as Extract<CoachAgentMsg, { type: '_toolUnregistered' }>)
    }

    return next(state, msg)
  }

  return {
    initialState: initialCoachState,
    lifecycle: onLifecycle({
      start: (state, ctx) => {
        const filter = options.toolFilter ?? COACH_TOOL_FILTER
        // Subscribe to tool registrations
        ctx.subscribe(ToolRegistrationTopic, (event) => {
          if (!applyToolFilter(event.name, filter)) return null
          if ('schema' in event && event.ref) {
            return {
              type:             '_toolRegistered' as const,
              name:             event.name,
              schema:           event.schema,
              ref:              event.ref,
              mayBeLongRunning: event.mayBeLongRunning,
            }
          }
          return { type: '_toolUnregistered' as const, name: event.name }
        })

        // Subscribe to context snapshots
        ctx.subscribe(ContextSnapshotTopic, (event) => {
          if (event.userId !== userId) return null
          return {
            type: '_contextSnapshot' as const,
            ...event,
          }
        })

        return { state }
      },
    }),

    handler:      loop.idle,
    interceptors: [hostInterceptor],

    stashCapacity: 100,
    supervision:   { type: 'restart', maxRetries: 3, withinMs: 30_000 },
  }
}
