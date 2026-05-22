import type { ActorDef, ActorRef, ActorContext, ActorResult, Interceptor } from '../../system/index.ts'
import { onLifecycle } from '../../system/index.ts'
import { agentLoop, idleLoopState, type LoopState } from '../../system/index.ts'
import { OutboundMessageTopic } from '../../types/events.ts'
import type { ToolCollection, ToolFilter } from '../../types/tools.ts'
import { applyToolFilter } from '../../system/index.ts'
import { ToolRegistrationTopic } from '../../types/tools.ts'
import type { ApiMessage } from '../../types/llm.ts'
import type { ToolMsg } from '../../types/tools.ts'
import { ContextSnapshotTopic, type AgentFactoryOpts } from '../../types/agents.ts'
import { assembleAgentMessages, type ContextView } from '../../system/index.ts'
import type { MessageAttachment } from '../../types/events.ts'
import { savePlanTool, updatePlanTool, deletePlanTool, listPlansTool, getPlanTool, showPlanGraphTool } from './tools.ts'
import type { PlannerAgentMsg, PlannerAgentState } from './types.ts'

// ─── Planner configuration (used to configure per-session planner instances) ───

export type PlannerAgentConfig = {
  model:             string
  plansDir:          string
  maxToolLoops:      number
  toolFilter?:       ToolFilter
  workflowToolsRef?: ActorRef<any>
}

const initialPlannerAgentState = (): PlannerAgentState => ({
  loop:                    idleLoopState(),
  contextView:             emptyContextView(),
  tools:                   {},
  pendingFormalizeSummary: null,
  activeClientId:          '',
})

const PLANNER_MODE = 'planner'

const emptyContextView = (userId = ''): ContextView => ({
  userId,
  version:        0,
  recentMessages: [],
  userContext:    null,
  modeSummaries:  {},
  toolSummaries:  [],
})


// ─── System prompt ───

const buildSystemPrompt = (): string =>
  `You are a planning assistant. Your role is to help the user create a detailed, actionable plan for their goal.
Today's date is ${new Date().toDateString()}.

You have access to:
- Research tools (web_search, fetch_file, etc.) to gather information proactively
- save_plan: save the final plan to disk once the user explicitly accepts it. Requires goal, summary, and tasks.
- update_plan: update an existing saved plan by id. You can modify goal, summary, and/or tasks.
- delete_plan: delete a saved plan by id.
- list_plans: list all saved plans.
- get_plan: read a saved plan by id.
- show_plan_graph: open the graphical DAG view for a plan.

Process:
1. Research the goal using available research tools to understand what is involved. Do this before asking the user anything you can look up yourself.
2. Ask the user clarifying questions directly in your response — be conversational. You do not need a special tool for questions. Ask ONE question at a time, wait for the user's answer, then ask the next question if needed.
Continue until you have gathered all constraints, preferences, and context required to build a complete plan.
3. Once you have enough context, describe the full plan to the user in your response. Include every task with its id, name, description, validation criteria, and dependencies.
4. Wait for the user's feedback. They may:
   - Accept the plan: call save_plan with the goal, summary, and full task list.
   - Request changes: do more research if needed and describe the revised plan. If the plan was already saved, use update_plan to apply changes.
   - Reject the plan: if they want to start over, use delete_plan to remove the saved plan.

After calling save_plan or update_plan, briefly acknowledge the save in one short sentence and stop — do not call any further tools in the same turn.

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
  const { model, maxToolLoops, toolFilter, plansDir, workflowToolsRef } = config
  const { userId, contextStoreRef, llmRef } = opts

  type M   = PlannerAgentMsg
  type S   = PlannerAgentState
  type Ctx = ActorContext<M>

  const buildTurnMessages = (state: PlannerAgentState, userMsg: ApiMessage): ApiMessage[] =>
    assembleAgentMessages(state.contextView, {
      mode:                      PLANNER_MODE,
      systemPrompt:              buildSystemPrompt(),
      includeUserContext:        true,
      includeCurrentModeSummary: true,
      includeOtherModeSummaries: false,
      includeToolSummaries:      true,
    }, userMsg)

  const resetScratch = (state: S): S => ({
    ...state,
    pendingFormalizeSummary: null,
  })

  const handleUserMessage = (state: S, msg: Extract<M, { type: 'userMessage' }>, ctx: Ctx): ActorResult<M, S> => {
    const userMsg: ApiMessage = { role: 'user', content: msg.text }
    const stateNext: S = {
      ...state,
      activeClientId: msg.clientId,
    }
    contextStoreRef.send({ type: 'append', mode: PLANNER_MODE, source: 'user', clientId: msg.clientId, injected: msg.isInjected || msg.isCron || false, messages: [userMsg] })
    return loop.startTurn(stateNext, {
      messages: buildTurnMessages(stateNext, userMsg),
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
        contextStoreRef.send({
          type:     'append',
          mode:     PLANNER_MODE,
          source:   'assistant',
          clientId: state.activeClientId,
          messages: [{ role: 'assistant', content: state.pendingFormalizeSummary }],
        })
        return { state: resetScratch(state) }
      }

      if (finalText) {
        contextStoreRef.send({ type: 'append', mode: PLANNER_MODE, source: 'assistant', clientId: state.activeClientId, messages: [{ role: 'assistant', content: finalText }] })
      }
      return { state }
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
      contextStoreRef.send({ type: 'append', mode: PLANNER_MODE, messages })
      return { state }
    },

    onToolResult: (state, result) => {
      if ((result.toolName === savePlanTool.name || result.toolName === updatePlanTool.name) && result.reply.type === 'toolResult') {
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

        ctx.subscribe(ContextSnapshotTopic, (event) => {
          if (event.userId !== userId) return null
          return {
            type: '_contextSnapshot' as const,
            ...event,
          }
        })

        ctx.log.info('planner-agent: started', { userId })

        const savePlanToolRef = workflowToolsRef as unknown as ActorRef<ToolMsg>
        if (!savePlanToolRef) {
          ctx.log.error('planner-agent: workflowToolsRef is not configured!')
        }

        const planTools = [savePlanTool, updatePlanTool, deletePlanTool, listPlansTool, getPlanTool, showPlanGraphTool]
        const tools: ToolCollection = {}
        for (const tool of planTools) {
          tools[tool.name] = { ...tool, ref: savePlanToolRef }
        }

        return {
          state: {
            ...state,
            tools: {
              ...state.tools,
              ...tools,
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
