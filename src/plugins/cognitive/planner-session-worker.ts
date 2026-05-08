import { mkdir } from 'node:fs/promises'
import { emit } from '../../system/types.ts'
import type { ActorDef, ActorRef, ActorContext, MessageHandler, ActorResult } from '../../system/types.ts'
import { onLifecycle, onMessage } from '../../system/match.ts'
import {
  createReactLoop,
  initialReactLoopSlice,
  type ReactInvokeMsg,
  type ReactLoopHandlers,
  type ReactLoopSlice,
} from '../../system/react-loop.ts'
import { OutboundMessageTopic } from '../../types/events.ts'
import type { ToolCollection } from '../../types/tools.ts'
import { JobRegistryTopic, type ToolReply } from '../../types/tools.ts'
import type { ApiMessage, LlmProviderMsg, Tool } from '../../types/llm.ts'
import type { Plan, PlanTask, PlannerSessionWorkerMsg, PlannerSupervisorMsg } from './types.ts'
import { PlannerActiveTopic } from './types.ts'

// ─── Options ───

export type PlannerSessionWorkerOptions = {
  model:         string
  plansDir:      string
  maxToolLoops:  number
  tools:         ToolCollection
  llmRef:        ActorRef<LlmProviderMsg>
  clientId:      string
  goal:          string
  jobId:         string
  /** Trace context inherited from the supervisor's invoke. Each turn becomes a child of this. */
  traceId?:      string
  parentSpanId?: string
}

// ─── State ───

export type PlannerSessionWorkerState = {
  loop:           ReactLoopSlice
  history:        ApiMessage[]
  pendingSummary: string | null
}

export const createInitialPlannerSessionWorkerState = (
  options: PlannerSessionWorkerOptions,
): PlannerSessionWorkerState => ({
  loop:           { ...initialReactLoopSlice(), llmRef: options.llmRef },
  history:        [{ role: 'user', content: options.goal }],
  pendingSummary: null,
})

// ─── Control tool schemas ───

const FORMALIZE_PLAN_TOOL: Tool = {
  type: 'function',
  function: {
    name: 'formalize_plan',
    description: 'Finalize and save the accepted plan to disk. Call this only when the user has explicitly approved the plan you described conversationally.',
    parameters: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'Brief narrative summary of the context gathered and key decisions made' },
        tasks: {
          type: 'array',
          description: 'Ordered list of tasks forming a DAG. Use "dependencies" to express ordering.',
          items: {
            type: 'object',
            properties: {
              id:                 { type: 'string', description: 'Short unique identifier' },
              name:               { type: 'string', description: 'Short task name' },
              description:        { type: 'string', description: 'What needs to be done' },
              validationCriteria: { type: 'string', description: 'How to verify this task is complete' },
              dependencies:       { type: 'array', items: { type: 'string' }, description: 'IDs of tasks that must complete before this one' },
            },
            required: ['id', 'name', 'description', 'validationCriteria', 'dependencies'],
          },
        },
      },
      required: ['summary', 'tasks'],
    },
  },
}

const ABORT_PLAN_TOOL: Tool = {
  type: 'function',
  function: {
    name: 'abort_plan',
    description: 'Call this tool when the user wants to cancel or abort the planning process entirely.',
    parameters: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: 'The reason for cancellation, if provided' },
      },
    },
  },
}

const CONTROL_TOOL_NAMES = new Set(['formalize_plan', 'abort_plan'])

// ─── System prompt ───

const buildSystemPrompt = (): string =>
  `You are a planning assistant. Your role is to help the user create a detailed, actionable plan for their goal.
Today's date is ${new Date().toDateString()}.

You have access to:
- Research tools (web_search, fetch_file, etc.) to gather information proactively
- formalize_plan: save the final plan to disk once the user explicitly accepts it
- abort_plan: cancel the session if the user no longer wishes to proceed

Process:
1. Research the goal using available research tools to understand what is involved. Do this before asking the user anything you can look up yourself.
2. Ask the user clarifying questions directly in your response — be conversational. You do not need a special tool for questions. Ask ONE question at a time, wait for the user's answer, then ask the next question if needed.
Continue until you have gathered all constraints, preferences, and context required to build a complete plan.
3. Once you have enough context, describe the full plan to the user in your response. Include every task with its id, name, description, validation criteria, and dependencies.
4. Wait for the user's feedback. They may:
   - Accept the plan: call formalize_plan with the plan structure.
   - Request changes: do more research if needed and describe the revised plan.
   - Cancel: call abort_plan.

Task quality guidelines:
- Each task must have a clear, specific name and description
- validationCriteria must be concrete and measurable
- dependencies must reflect genuine ordering constraints — form a valid DAG (no cycles)
- Prefer granular tasks over vague large ones

Be concise. Research first, then ask only what you genuinely need from the user.`

// ─── Helpers ───

const todayISO = (): string => new Date().toISOString().slice(0, 10)

const slugify = (text: string): string =>
  text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50)

// ─── Actor ───

export const createPlannerSessionWorkerActor = (
  parent:  ActorRef<PlannerSupervisorMsg>,
  options: PlannerSessionWorkerOptions,
): ActorDef<PlannerSessionWorkerMsg, PlannerSessionWorkerState> => {
  const { model, plansDir, maxToolLoops, tools, clientId, goal, jobId, traceId, parentSpanId } = options

  type M   = PlannerSessionWorkerMsg
  type S   = PlannerSessionWorkerState
  type Ctx = ActorContext<M>

  // The replyTo on synthesized invokes is unused (planner streams via OutboundMessageTopic),
  // but ReactInvokeMsg requires the field. A no-op sink keeps the type honest.
  const noopReplyTo: ActorRef<ToolReply> = {
    name: 'planner-noop-sink',
    send: () => {},
  } as unknown as ActorRef<ToolReply>

  // Forward refs.
  let formalizing: MessageHandler<M, S>
  let done:        MessageHandler<M, S>
  let handlers:    ReactLoopHandlers<M, S>

  const finishSession = (
    state:   S,
    ctx:     Ctx,
    summary: string | null,
    failure: string | null,
  ): S => {
    ctx.publishRetained(PlannerActiveTopic, clientId, {
      clientId, plannerRef: null, summary: summary ?? undefined,
    })
    if (failure) {
      ctx.publishRetained(JobRegistryTopic, jobId, { jobId, status: 'failed', error: failure })
    } else if (summary) {
      ctx.publishRetained(JobRegistryTopic, jobId, { jobId, status: 'completed', result: { text: summary } })
    }
    parent.send({ type: '_workerDone', worker: { name: ctx.self.name } })
    return { ...state, pendingSummary: summary ?? failure ?? state.pendingSummary }
  }

  const synthesizeInvoke = (text: string): ReactInvokeMsg => ({
    type:         'invoke',
    toolName:     'planner-turn',
    arguments:    text,
    clientId,
    userId:       '',
    replyTo:      noopReplyTo,
    traceId,
    parentSpanId,
  })

  // ── React-loop construction ─────────────────────────────────────────────

  handlers = createReactLoop<S, M>({
    role:         'planner',
    spanName:     'planner-turn',
    logPrefix:    'planner-session',
    model,
    maxToolLoops,
    tools:        () => tools,
    extraToolSchemas: () => [FORMALIZE_PLAN_TOOL, ABORT_PLAN_TOOL],
    spans:        traceId && parentSpanId ? 'fromMessage' : 'never',

    slice:    (s) => s.loop,
    setSlice: (s, loop) => ({ ...s, loop }),

    buildTurn: (state) => ({
      messages: [{ role: 'system', content: buildSystemPrompt() }, ...state.history],
    }),

    // Per-chunk streaming: matches today's planner UX of emitting once on
    // llmDone (see onComplete). React-loop's onChunk hook can't carry events,
    // so we deliberately omit it here and rely on the single emit at done.

    onComplete: (state, finalText, _ctx) => {
      const events = finalText
        ? [
            emit(OutboundMessageTopic, { clientId, text: JSON.stringify({ type: 'chunk', text: finalText }) }),
            emit(OutboundMessageTopic, { clientId, text: JSON.stringify({ type: 'done' }) }),
          ]
        : []
      const newHistory: ApiMessage[] = finalText
        ? [...state.history, { role: 'assistant', content: finalText }]
        : state.history
      return { state: { ...state, history: newHistory }, events }
    },

    onLlmError: (state, error, ctx) => {
      ctx.log.error('planner-session: LLM error', { jobId, error: String(error) })
      const next = finishSession(state, ctx, null, 'The planner encountered an error. Please try again.')
      return {
        state:  next,
        become: done,
        events: [
          emit(OutboundMessageTopic, { clientId, text: JSON.stringify({ type: 'plannerMode', active: false }) }),
          emit(OutboundMessageTopic, { clientId, text: JSON.stringify({ type: 'error', text: 'The planner encountered an error. Please try again.' }) }),
        ],
      }
    },

    onLoopLimit: (state, _finalText, ctx) => {
      ctx.log.warn('planner-session: tool loop limit reached', { jobId })
      const next = finishSession(state, ctx, null, 'Tool loop limit reached in planner. Please try again.')
      return {
        state:  next,
        become: done,
        events: [
          emit(OutboundMessageTopic, { clientId, text: JSON.stringify({ type: 'plannerMode', active: false }) }),
          emit(OutboundMessageTopic, { clientId, text: JSON.stringify({ type: 'error', text: 'Tool loop limit reached in planner. Please try again.' }) }),
        ],
      }
    },

    interceptToolCalls: (state, calls, ctx) => {
      const controlCalls = calls.filter(c => CONTROL_TOOL_NAMES.has(c.name))

      // If there are no control calls, let the loop dispatch external tools normally.
      if (controlCalls.length === 0) return { handled: false }

      // Control call takes precedence (mirrors prior behavior).
      const controlCall = controlCalls[0]!

      // Append the assistant tool-call to history so subsequent flow has it.
      const assistantMsg: ApiMessage = {
        role: 'assistant', content: null,
        tool_calls: [{ id: controlCall.id, type: 'function', function: { name: controlCall.name, arguments: controlCall.arguments } }],
      }
      const updatedHistory = [...state.history, assistantMsg]

      if (controlCall.name === 'formalize_plan') {
        let summary: string
        let rawTasks: PlanTask[]
        try {
          const args = JSON.parse(controlCall.arguments) as { summary?: string; tasks?: PlanTask[] }
          summary  = args.summary ?? ''
          rawTasks = args.tasks ?? []
        } catch {
          const next = finishSession(state, ctx, null, 'Planner produced an invalid plan format. Please try again.')
          return {
            handled: true,
            result: {
              state: next, become: done,
              events: [
                emit(OutboundMessageTopic, { clientId, text: JSON.stringify({ type: 'plannerMode', active: false }) }),
                emit(OutboundMessageTopic, { clientId, text: JSON.stringify({ type: 'error', text: 'Planner produced an invalid plan format. Please try again.' }) }),
              ],
            },
          }
        }

        const plan: Plan = {
          id:        crypto.randomUUID(),
          goal,
          context:   summary,
          createdAt: new Date().toISOString(),
          tasks:     rawTasks,
        }
        const shortId  = crypto.randomUUID().slice(0, 8)
        const filename = `${todayISO()}-${slugify(plan.goal)}-${shortId}.json`
        const filepath = `${plansDir}/${filename}`
        const saveSummary = `Goal: ${plan.goal}. ${plan.context} Plan saved to ${filepath} — ${plan.tasks.length} tasks.`

        ctx.pipeToSelf(
          (async () => {
            await mkdir(plansDir, { recursive: true })
            await Bun.write(filepath, JSON.stringify(plan, null, 2))
          })(),
          (): M  => ({ type: '_planWriteDone',  filepath }),
          (err): M => ({ type: '_planWriteError', error: String(err) }),
        )

        ctx.log.info('planner-session: formalizing plan', { jobId, filepath, tasks: plan.tasks.length })

        return {
          handled: true,
          result: {
            state:  { ...state, history: updatedHistory, pendingSummary: saveSummary },
            become: formalizing,
            events: [emit(OutboundMessageTopic, { clientId, text: JSON.stringify({ type: 'chunk', text: 'Saving your plan…' }) })],
          },
        }
      }

      // abort_plan
      let reason = 'Planning session cancelled.'
      try {
        reason = (JSON.parse(controlCall.arguments) as { reason?: string }).reason ?? reason
      } catch {
        reason = controlCall.arguments || reason
      }
      ctx.log.info('planner-session: aborted by user', { jobId, reason })
      const next = finishSession(state, ctx, null, reason)
      return {
        handled: true,
        result: {
          state:  { ...next, history: updatedHistory },
          become: done,
          events: [
            emit(OutboundMessageTopic, { clientId, text: JSON.stringify({ type: 'plannerMode', active: false }) }),
            emit(OutboundMessageTopic, { clientId, text: JSON.stringify({ type: 'error', text: reason }) }),
          ],
        },
      }
    },

    extraCases: {
      idle: {
        userMessage: (state: S, msg: { type: 'userMessage'; clientId: string; text: string }, ctx: Ctx): ActorResult<M, S> => {
          if (msg.clientId !== clientId) return { state }
          ctx.log.info('planner-session: user input while idle', { jobId, text: msg.text.slice(0, 100) })
          const userMsg: ApiMessage = { role: 'user', content: msg.text }
          const stateWithHistory: S = { ...state, history: [...state.history, userMsg] }
          return handlers.idle(stateWithHistory, synthesizeInvoke(msg.text) as unknown as M, ctx)
        },
      },
    },
  })

  // Custom handlers reachable only via interceptToolCalls / onLlmError / onLoopLimit.

  formalizing = onMessage<M, S>({
    _planWriteDone: (state, msg, ctx) => {
      const summary = state.pendingSummary ?? `Plan saved to ${msg.filepath}.`
      ctx.log.info('planner-session: complete', { jobId, filepath: msg.filepath })
      const next = finishSession(state, ctx, summary, null)
      return {
        state:  next,
        become: done,
        events: [
          emit(OutboundMessageTopic, { clientId, text: JSON.stringify({ type: 'plannerMode', active: false }) }),
          emit(OutboundMessageTopic, { clientId, text: JSON.stringify({ type: 'chunk', text: `\nPlan saved to \`${msg.filepath}\`` }) }),
          emit(OutboundMessageTopic, { clientId, text: JSON.stringify({ type: 'done' }) }),
        ],
      }
    },

    _planWriteError: (state, msg, ctx) => {
      ctx.log.error('planner-session: failed to write plan', { jobId, error: msg.error })
      const next = finishSession(state, ctx, null, msg.error)
      return {
        state:  next,
        become: done,
        events: [
          emit(OutboundMessageTopic, { clientId, text: JSON.stringify({ type: 'plannerMode', active: false }) }),
          emit(OutboundMessageTopic, { clientId, text: JSON.stringify({ type: 'error', text: `Failed to save plan: ${msg.error}` }) }),
        ],
      }
    },
  })

  // Terminal: drop late arrivals until the supervisor stops us.
  done = onMessage<M, S>({})

  return {
    lifecycle: onLifecycle({
      start: (state, ctx) => {
        ctx.log.info('planner-session: started', { jobId, clientId, goal: goal.slice(0, 100) })
        // Kick off the first turn by self-sending a synthetic invoke. The goal
        // is already seeded in state.history, so buildTurn will pick it up.
        ctx.self.send(synthesizeInvoke(goal) as unknown as M)
        return { state }
      },
    }),

    handler: handlers.idle,

    supervision: { type: 'restart', maxRetries: 3, withinMs: 30_000 },
  }
}
