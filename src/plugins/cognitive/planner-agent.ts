import { emit } from '../../system/types.ts'
import type { ActorDef, ActorRef, ActorContext, ActorResult } from '../../system/types.ts'
import { onLifecycle } from '../../system/match.ts'
import {
  AgentLoop,
  initialAgentLoopSlice,
  type AgentLoopPhases,
  type AgentLoopTriggers,
  type AgentLoopSlice,
  type LoopMsg,
} from '../../system/agent-loop.ts'
import { OutboundMessageTopic } from '../../types/events.ts'
import type { ToolCollection, ToolFilter } from '../../types/tools.ts'
import { applyToolFilter, ToolRegistrationTopic } from '../../types/tools.ts'
import { LlmProviderTopic } from '../../types/llm.ts'
import type { ApiMessage, LlmProviderMsg } from '../../types/llm.ts'
import type { ToolMsg } from '../../types/tools.ts'
import type { AgentFactoryOpts } from './types.ts'
import {
  FORMALIZE_PLAN_TOOL_NAME,
  FORMALIZE_PLAN_SCHEMA,
  FormalizePlanTool,
} from './formalize-plan-tool.ts'

// ─── Message protocol ───

type PlannerExtra =
  | { type: 'userMessage'; clientId: string; text: string; images?: string[]; audio?: string; pdfs?: string[]; isCron?: boolean; isInjected?: boolean }

export type PlannerAgentMsg = LoopMsg<PlannerExtra>

// ─── State ───
//
// The planner owns a *scratch* conversation history that's distinct from the
// shared HistoryStore. The shared store only sees a single condensed summary
// when the user formalizes a plan — keeping the noisy multi-iteration
// planning chatter out of other agents' context.

export type PlannerAgentState = {
  loop:                    AgentLoopSlice
  plannerHistory:          ApiMessage[]
  tools:                   ToolCollection
  pendingFormalizeSummary: string | null
  activeClientId:          string
}

const initialPlannerAgentState = (): PlannerAgentState => ({
  loop:                    initialAgentLoopSlice(),
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
//
// Curried so cognitive.plugin.ts can register the descriptor with the
// planner config closed over, while SessionManager supplies per-instance
// AgentFactoryOpts (userId, clientId, llmRef, historyStoreRef) at spawn time.

export const PlannerAgentFactory = (config: PlannerAgentConfig) =>
  (opts: AgentFactoryOpts): ActorDef<PlannerAgentMsg, PlannerAgentState> =>
    PlannerAgent(config, opts)

// ─── Actor ───

const PlannerAgent = (
  config: PlannerAgentConfig,
  opts:   AgentFactoryOpts,
): ActorDef<PlannerAgentMsg, PlannerAgentState> => {
  const { model, maxToolLoops, toolFilter, plansDir } = config
  const { userId, historyStoreRef } = opts

  type M   = PlannerAgentMsg
  type S   = PlannerAgentState
  type Ctx = ActorContext<M>

  let loop: { phases: AgentLoopPhases<M, S>; triggers: AgentLoopTriggers<M, S> }

  const buildTurnMessages = (state: S): ApiMessage[] =>
    [{ role: 'system', content: buildSystemPrompt() }, ...state.plannerHistory]

  const resetScratch = (state: S): S => ({
    ...state,
    plannerHistory:          [],
    pendingFormalizeSummary: null,
  })

  loop = AgentLoop<S, M>({
    role:         'planner',
    spanName:     'planner-turn',
    logPrefix:    'planner',
    model,
    maxToolLoops,
    tools:        (s) => s.tools,
    onComplete: (state, finalText, ctx) => {
      // Formalize-plan branch: the prior tool result populated
      // pendingFormalizeSummary. Forward the canonical summary to the shared
      // HistoryStore, drop the planner scratch, and emit done. The LLM's
      // closing chatter (finalText) was already streamed via onChunk and
      // does not need to be retained.
      if (state.pendingFormalizeSummary) {
        ctx.log.info('planner: formalized plan, resetting scratch', { userId })
        historyStoreRef.send({
          type:     'append',
          messages: [{ role: 'assistant', content: state.pendingFormalizeSummary }],
        })
        return {
          state:  resetScratch(state),
          events: [emit(OutboundMessageTopic, { clientId: state.activeClientId, text: JSON.stringify({ type: 'done' }) })],
        }
      }

      const newPlannerHistory: ApiMessage[] = finalText
        ? [...state.plannerHistory, { role: 'assistant', content: finalText }]
        : state.plannerHistory
      return {
        state:  { ...state, plannerHistory: newPlannerHistory },
        events: [emit(OutboundMessageTopic, { clientId: state.activeClientId, text: JSON.stringify({ type: 'done' }) })],
      }
    },

    onLlmError: (state, error, ctx) => {
      ctx.log.error('planner: LLM error', { userId, error: String(error) })
      return {
        state,
        events: [emit(OutboundMessageTopic, { clientId: state.activeClientId, text: JSON.stringify({ type: 'error', text: 'The planner encountered an error. Please try again.' }) })],
      }
    },

    onLoopLimit: (state, _finalText, ctx) => {
      ctx.log.warn('planner: tool loop limit reached', { userId })
      return {
        state,
        events: [emit(OutboundMessageTopic, { clientId: state.activeClientId, text: JSON.stringify({ type: 'error', text: 'Tool loop limit reached in planner. Please try again.' }) })],
      }
    },

    // Mirror tool batches into local plannerHistory so subsequent turns
    // include them. The shared HistoryStore only receives the formalized
    // plan summary (in onComplete).
    onBatchHistoryReady: (state, messages) => {
      return { state: { ...state, plannerHistory: [...state.plannerHistory, ...messages] } }
    },

    // Observe the formalize-plan tool result and stash its summary text.
    // onComplete consumes the flag at the next turn boundary.
    onToolResult: (state, result) => {
      if (result.toolName === FORMALIZE_PLAN_TOOL_NAME && result.reply.type === 'toolResult') {
        return { state: { ...state, pendingFormalizeSummary: result.reply.result.text } }
      }
      return { state }
    },

    extraCases: {
      idle: {
        userMessage: (state: S, msg: Extract<M, { type: 'userMessage' }>, ctx: Ctx): ActorResult<M, S> => {
          const userMsg: ApiMessage = { role: 'user', content: msg.text }
          const stateNext: S = {
            ...state,
            activeClientId: msg.clientId,
            plannerHistory: [...state.plannerHistory, userMsg],
          }
          if (!stateNext.loop.llmRef) {
            ctx.log.warn('planner: dropping userMessage, no LLM ref', { clientId: msg.clientId })
            return { state: stateNext }
          }
          return loop.triggers.startTurn(stateNext, {
            messages:     buildTurnMessages(stateNext),
            userId,
            clientId:     msg.clientId,
          }, ctx)
        },
      },
    },
  })

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

        ctx.subscribe(LlmProviderTopic, (event) =>
          ({ type: '_llmProvider' as const, ref: event.ref }),
        )

        ctx.log.info('planner-agent: started', { userId })

        // Spawn the planner's private formalize-plan tool as a child actor.
        // It does not flow through ToolRegistrationTopic — only this planner sees it.
        const formalizePlanToolRef = ctx.spawn(
          'formalize-plan-tool',
          FormalizePlanTool({ plansDir }),
        ) as ActorRef<ToolMsg>

        return {
          state: {
            ...state,
            tools: {
              ...state.tools,
              [FORMALIZE_PLAN_TOOL_NAME]: {
                schema: FORMALIZE_PLAN_SCHEMA,
                ref:    formalizePlanToolRef,
              },
            },
          },
        }
      },
    }),

    handler: loop.phases.idle,

    supervision: { type: 'restart', maxRetries: 3, withinMs: 30_000 },
  }
}
