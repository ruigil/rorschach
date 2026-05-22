import type { ActorContext, ActorDef, ActorResult, Interceptor } from '../../system/types.ts'
import { onLifecycle } from '../../system/match.ts'
import { agentLoop, idleLoopState, type LoopState } from '../../system/agent-loop.ts'
import { OutboundMessageTopic } from '../../types/events.ts'
import type { ApiMessage, LlmProviderMsg } from '../../types/llm.ts'
import type { ToolCollection } from '../../types/tools.ts'
import type { ActorRef } from '../../system/types.ts'
import { ContextSnapshotTopic, type AgentFactoryOpts, type AgentContextMsg } from '../../types/agents.ts'
import { assembleAgentMessages, type ContextView } from '../../system/context-assembly.ts'
import type { ExecutorAgentMsg } from './types.ts'

export type ExecutorAgentOptions = {
  model: string
  maxToolLoops: number
  tools: ToolCollection
  userId: string
  llmRef: ActorRef<LlmProviderMsg>
  contextStoreRef: ActorRef<AgentContextMsg>
}

export type ExecutorAgentState = {
  loop: LoopState
  contextView: ContextView
  activeClientId: string
}

const EXECUTOR_MODE = 'executor'

const emptyContextView = (userId = ''): ContextView => ({
  userId,
  version:        0,
  recentMessages: [],
  userContext:    null,
  modeSummaries:  {},
  toolSummaries:  [],
})

const initialState = (): ExecutorAgentState => ({
  loop: idleLoopState(),
  contextView: emptyContextView(),
  activeClientId: '',
})

const buildSystemPrompt = (): string =>
  `You are the executor agent for saved plans. Today is ${new Date().toDateString()}.

You help the user inspect and discuss plans that were previously created by the planner.
You can list plans, read a plan, and open a graphical DAG for a plan.

Use list_plans when the user asks what plans exist.
Use get_plan before answering detailed questions about a plan's tasks, dependencies, or validation criteria.
Use show_plan_graph when the user asks to see, show, open, visualize, or inspect the DAG/graph.

This version is read-only. Do not claim to start, complete, block, reschedule, or execute tasks. If the user asks for those actions, explain that task execution tracking is not available yet and answer from the saved plan content.`

export const ExecutorAgent = (options: ExecutorAgentOptions): ActorDef<ExecutorAgentMsg, ExecutorAgentState> => {
  type M = ExecutorAgentMsg
  type S = ExecutorAgentState
  type Ctx = ActorContext<M>

  const buildTurnMessages = (state: S, userMsg: ApiMessage): ApiMessage[] =>
    assembleAgentMessages(state.contextView, {
      mode:                      EXECUTOR_MODE,
      systemPrompt:              buildSystemPrompt(),
      includeUserContext:        false,
      includeCurrentModeSummary: true,
      includeOtherModeSummaries: false,
      includeToolSummaries:      true,
    }, userMsg)

  const handleUserMessage = (state: S, msg: Extract<M, { type: 'userMessage' }>, ctx: Ctx): ActorResult<M, S> => {
    const userMsg: ApiMessage = { role: 'user', content: msg.text }
    const nextState = {
      ...state,
      activeClientId: msg.clientId,
    }
    options.contextStoreRef.send({ type: 'append', mode: EXECUTOR_MODE, source: 'user', clientId: msg.clientId, injected: msg.isInjected || msg.isCron || false, messages: [userMsg] })
    return loop.startTurn(nextState, {
      messages: buildTurnMessages(nextState, userMsg),
      userId: options.userId,
      clientId: msg.clientId,
    }, ctx)
  }

  const loop = agentLoop<S, M>({
    role:         'executor',
    spanName:     'executor-turn',
    logPrefix:    'executor',
    model:        options.model,
    maxToolLoops: options.maxToolLoops,
    llmRef:       () => options.llmRef,
    tools:        options.tools,
    uiEvents:     OutboundMessageTopic,
    errorMessages: {
      llm:       'The executor encountered an error. Please try again.',
      loopLimit: 'Tool loop limit reached in executor. Please try again.',
    },
    onComplete: (state, finalText) => {
      if (finalText) {
        options.contextStoreRef.send({ type: 'append', mode: EXECUTOR_MODE, source: 'assistant', clientId: state.activeClientId, messages: [{ role: 'assistant', content: finalText }] })
      }
      return { state }
    },
    onError: (state) => ({ state }),
    onBatchHistoryReady: (state, messages) => {
      options.contextStoreRef.send({ type: 'append', mode: EXECUTOR_MODE, messages })
      return { state }
    },
  })

  const hostInterceptor: Interceptor<M, S> = (state, msg, ctx, next) => {
    const m = msg as M

    if (m.type === 'userMessage') {
      if (state.loop.phase !== 'idle') return { state, stash: true }
      return handleUserMessage(state, m as Extract<M, { type: 'userMessage' }>, ctx)
    }

    if (m.type === '_contextSnapshot') {
      return {
        state: {
          ...state,
          contextView: {
            userId:         m.userId,
            version:        m.version,
            recentMessages: m.recentMessages,
            userContext:    m.userContext,
            modeSummaries:  m.modeSummaries,
            toolSummaries:  m.toolSummaries,
          },
        },
      }
    }

    return next(state, msg)
  }

  return {
    initialState,
    lifecycle: onLifecycle({
      start: (state, ctx) => {
        ctx.subscribe(ContextSnapshotTopic, (event) => {
          if (event.userId !== options.userId) return null
          return {
            type: '_contextSnapshot' as const,
            ...event,
          }
        })
        return { state }
      },
    }),
    handler: loop.idle,
    interceptors: [hostInterceptor],
    stashCapacity: 50,
    supervision: { type: 'restart', maxRetries: 3, withinMs: 30_000 },
  }
}

export const ExecutorAgentFactory = (options: Omit<ExecutorAgentOptions, 'userId' | 'llmRef' | 'contextStoreRef'>) =>
  (opts: AgentFactoryOpts): ActorDef<ExecutorAgentMsg, ExecutorAgentState> => ExecutorAgent({
    ...options,
    userId: opts.userId,
    llmRef: opts.llmRef,
    contextStoreRef: opts.contextStoreRef,
  })
