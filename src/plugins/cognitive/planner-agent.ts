import type { ActorDef, ActorRef, ActorContext, ActorResult, Interceptor } from '../../system/types.ts'
import { onLifecycle } from '../../system/match.ts'
import { agentLoop, idleLoopState, type LoopState } from '../../system/agent-loop.ts'
import { OutboundMessageTopic } from '../../types/events.ts'
import type { ToolCollection, ToolFilter } from '../../types/tools.ts'
import { applyToolFilter, ToolRegistrationTopic } from '../../types/tools.ts'
import type { ApiMessage } from '../../types/llm.ts'
import type { ToolMsg } from '../../types/tools.ts'
import type { AgentFactoryOpts } from './types.ts'
import {
  formalizePlanTool,
  FormalizePlanTool,
} from './formalize-plan-tool.ts'

// ─── Message protocol ───

type PlannerExtra =
  | { type: 'userMessage'; clientId: string; text: string; images?: string[]; audio?: string; pdfs?: string[]; isCron?: boolean; isInjected?: boolean }
  | { type: '_toolRegistered'; name: string; schema: import('../../types/tools.ts').ToolSchema; ref: ActorRef<ToolMsg>; mayBeLongRunning?: boolean }
  | { type: '_toolUnregistered'; name: string }

export type PlannerAgentMsg = import('../../system/agent-loop.ts').LoopMsg<PlannerExtra>

// ─── State ───

export type PlannerAgentState = {
  loop:                    LoopState
  plannerHistory:          ApiMessage[]
  tools:                   ToolCollection
  pendingFormalizeSummary: string | null
  activeClientId:          string
}

const initialPlannerAgentState = (): PlannerAgentState => ({
  loop:                    idleLoopState(),
  plannerHistory:          [],
  tools:                   {},
  pendingFormalizeSummary: null,
  activeClientId:          '',
})

// ─── Config ───

export type PlannerAgentConfig = {
  model:        string
  maxToolLoops: number
  toolFilter?:  ToolFilter
  plansDir:     string
}

// ─── System prompt ───

const buildSystemPrompt = (): string =>
  `You are a planning assistant. Your role is to help the user create a detailed, actionable plan for their goal.
Today's date is ${new Date().toDateString()}.

You have access to:
- Research tools (web_search, fetch_file, etc.) to gather information proactively
- formalize_plan: save the final plan to disk once the user explicitly accepts it. Requires goal, summary, and tasks.

Process:
1. Research the goal using available research tools to understand what is involved. Do this before asking the user anything you can look up yourself.
2. Ask the user clarifying questions directly in your response — be conversational. You do not need a special tool for questions. Ask ONE question at a time, wait for the user's answer, then ask the next question if needed.
Continue until you have gathered all constraints, preferences, and context required to build a complete plan.
3. Once you have enough context, describe the full plan to the user in your response. Include every task with its id, name, description, validation criteria, and dependencies.
4. Wait for the user's feedback. They may:
   - Accept the plan: call formalize_plan with the goal, summary, and full task list.
   - Request changes: do more research if needed and describe the revised plan.

After calling formalize_plan, briefly acknowledge the save in one short sentence and stop — do not call any further tools in the same turn.

Task quality guidelines:
- Each task must have a clear, specific name and description
- validationCriteria must be concrete and measurable
- dependencies must reflect genuine ordering constraints — form a valid DAG (no cycles)
- Prefer granular tasks over vague large ones

Be concise. Research first, then ask only what you genuinely need from the user.`

// ─── Factory ───

export const PlannerAgentFactory = (config: PlannerAgentConfig) =>
  (opts: AgentFactoryOpts): ActorDef<PlannerAgentMsg, PlannerAgentState> => PlannerAgent(config, opts)

// ─── Actor ───

const PlannerAgent = (config: PlannerAgentConfig, opts: AgentFactoryOpts): ActorDef<PlannerAgentMsg, PlannerAgentState> => {
  const { model, maxToolLoops, toolFilter, plansDir } = config
  const { userId, historyStoreRef, llmRef } = opts

  type M   = PlannerAgentMsg
  type S   = PlannerAgentState
  type Ctx = ActorContext<M>

  const buildTurnMessages = (state: PlannerAgentState): ApiMessage[] =>
    [{ role: 'system', content: buildSystemPrompt() }, ...state.plannerHistory]

  const resetScratch = (state: S): S => ({
    ...state,
    plannerHistory:          [],
    pendingFormalizeSummary: null,
  })

  const handleUserMessage = (state: S, msg: Extract<M, { type: 'userMessage' }>, ctx: Ctx): ActorResult<M, S> => {
    const userMsg: ApiMessage = { role: 'user', content: msg.text }
    const stateNext: S = {
      ...state,
      activeClientId: msg.clientId,
      plannerHistory: [...state.plannerHistory, userMsg],
    }
    return loop.startTurn(stateNext, {
      messages: buildTurnMessages(stateNext),
      userId,
      clientId: msg.clientId,
    }, ctx)
  }

  const loop = agentLoop<PlannerAgentState, PlannerAgentMsg>({
    role:         'planner',
    spanName:     'planner-turn',
    logPrefix:    'planner',
    model,
    maxToolLoops,
    llmRef:       () => llmRef,
    tools:        (s) => s.tools,

    uiEvents:      OutboundMessageTopic,
    errorMessages: {
      llm:      'The planner encountered an error. Please try again.',
      loopLimit: 'Tool loop limit reached in planner. Please try again.',
    },

    onComplete: (state, finalText, _usage, ctx) => {
      if (state.pendingFormalizeSummary) {
        ctx.log.info('planner: formalized plan, resetting scratch', { userId })
        historyStoreRef.send({
          type:     'append',
          messages: [{ role: 'assistant', content: state.pendingFormalizeSummary }],
        })
        return { state: resetScratch(state) }
      }

      const newPlannerHistory: ApiMessage[] = finalText
        ? [...state.plannerHistory, { role: 'assistant', content: finalText }]
        : state.plannerHistory
      return { state: { ...state, plannerHistory: newPlannerHistory } }
    },

    onError: (state, err, ctx) => {
      if (err.kind === 'llm') {
        ctx.log.error('planner: LLM error', { userId, error: String(err.error) })
      } else {
        ctx.log.warn('planner: tool loop limit reached', { userId })
      }
      return { state }
    },

    onBatchHistoryReady: (state, messages) => {
      return { state: { ...state, plannerHistory: [...state.plannerHistory, ...messages] } }
    },

    onToolResult: (state, result) => {
      if (result.toolName === formalizePlanTool.name && result.reply.type === 'toolResult') {
        return { state: { ...state, pendingFormalizeSummary: result.reply.result.text } }
      }
      return { state }
    },
  })

  const hostInterceptor: Interceptor<M, S> = (state, msg, ctx, next) => {
    const m = msg as M

    if (m.type === 'userMessage') {
      if (state.loop.phase !== 'idle') return { state, stash: true }
      return handleUserMessage(state, m as Extract<M, { type: 'userMessage' }>, ctx)
    }

    if (m.type === '_toolRegistered') {
      return {
        state: {
          ...state,
          tools: {
            ...state.tools,
            [m.name]: { name: m.name, schema: m.schema, ref: m.ref, mayBeLongRunning: m.mayBeLongRunning },
          },
        },
      }
    }

    if (m.type === '_toolUnregistered') {
      const { [m.name]: _, ...rest } = state.tools
      return { state: { ...state, tools: rest } }
    }

    return next(state, msg)
  }

  return {
    initialState: initialPlannerAgentState,
    lifecycle: onLifecycle({
      start: (state, ctx) => {
        ctx.subscribe(ToolRegistrationTopic, (event) => {
          if (!applyToolFilter(event.name, toolFilter)) return null
          if ('schema' in event) {
            return {
              type: '_toolRegistered' as const,
              name: event.name,
              schema: event.schema,
              ref: event.ref,
              mayBeLongRunning: event.mayBeLongRunning,
            }
          }
          return { type: '_toolUnregistered' as const, name: event.name }
        })

        ctx.log.info('planner-agent: started', { userId })

        const formalizePlanToolRef = ctx.spawn('formalize-plan-tool', FormalizePlanTool({ plansDir })) as ActorRef<ToolMsg>

        return {
          state: {
            ...state,
            tools: {
              ...state.tools,
              [formalizePlanTool.name]: {
                ...formalizePlanTool,
                ref: formalizePlanToolRef,
              },
            },
          },
        }
      },
    }),

    handler:      loop.idle,
    interceptors: [hostInterceptor],

    supervision: { type: 'restart', maxRetries: 3, withinMs: 30_000 },
  }
}
