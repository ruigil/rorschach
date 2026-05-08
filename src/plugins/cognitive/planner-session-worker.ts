import { mkdir } from 'node:fs/promises'
import { emit } from '../../system/types.ts'
import type { ActorDef, ActorRef, ActorContext, MessageHandler } from '../../system/types.ts'
import { onLifecycle, onMessage } from '../../system/match.ts'
import { invokeTool } from '../../system/invoke-tool.ts'
import { OutboundMessageTopic } from '../../types/events.ts'
import type { ToolCollection, ToolEntry } from '../../types/tools.ts'
import { JobRegistryTopic } from '../../types/tools.ts'
import type { ApiMessage, LlmProviderMsg, LlmProviderReply, Tool, ToolCall } from '../../types/llm.ts'
import type { Plan, PlanTask, PlannerSessionWorkerMsg, PlannerSupervisorMsg } from './types.ts'
import { PlannerActiveTopic } from './types.ts'

// ─── Options ───

export type PlannerSessionWorkerOptions = {
  model:        string
  plansDir:     string
  maxToolLoops: number
  tools:        ToolCollection
  llmRef:       ActorRef<LlmProviderMsg>
  clientId:     string
  goal:         string
  jobId:        string
}

// ─── State ───
//
// The current behavior (awaitingLlm / toolLoop / idle / formalizing / done) is
// encoded in the active handler via `become`, not in a state field.

type PendingBatch = {
  remaining:          number
  results:            Array<{ toolCallId: string; toolName: string; content: string }>
  messagesAtCall:     ApiMessage[]
  assistantToolCalls: ToolCall[]
}

export type PlannerSessionWorkerState = {
  history:        ApiMessage[]
  requestId:      string | null
  pending:        string
  pendingBatch:   PendingBatch | null
  toolLoopCount:  number
  pendingSummary: string | null
}

export const createInitialPlannerSessionWorkerState = (
  options: PlannerSessionWorkerOptions,
): PlannerSessionWorkerState => ({
  history:        [{ role: 'user', content: options.goal }],
  requestId:      null,
  pending:        '',
  pendingBatch:   null,
  toolLoopCount:  0,
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
        summary: {
          type: 'string',
          description: 'Brief narrative summary of the context gathered and key decisions made',
        },
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

const buildTools = (tools: ToolCollection): Tool[] => [
  FORMALIZE_PLAN_TOOL,
  ABORT_PLAN_TOOL,
  ...Object.values(tools).map((e: ToolEntry) => e.schema as Tool),
]

// ─── Actor ───

export const createPlannerSessionWorkerActor = (
  parent:  ActorRef<PlannerSupervisorMsg>,
  options: PlannerSessionWorkerOptions,
): ActorDef<PlannerSessionWorkerMsg, PlannerSessionWorkerState> => {
  const { model, plansDir, maxToolLoops, tools, llmRef, clientId, goal, jobId } = options

  type M       = PlannerSessionWorkerMsg
  type S       = PlannerSessionWorkerState
  type Ctx     = ActorContext<M>
  type Emitted = ReturnType<typeof emit>

  // `awaitingLlm` is the only handler reached by forward reference (idle and
  // toolLoop both transition into it). Forward-declare with `let`; assign at
  // the bottom. The rest are `const` declared in dependency order.
  let awaitingLlm: MessageHandler<M, S>

  // ── Side-effect helpers ──────────────────────────────────────────────────

  const sendToLlm = (
    state:    S,
    ctx:      Ctx,
    messages: ApiMessage[],
  ): S => {
    const requestId = crypto.randomUUID()
    llmRef.send({
      type:     'stream',
      requestId,
      model,
      messages: [{ role: 'system', content: buildSystemPrompt() }, ...messages],
      tools:    buildTools(tools),
      role:     'planner',
      clientId,
      replyTo:  ctx.self as unknown as ActorRef<LlmProviderReply>,
    })
    return { ...state, requestId }
  }

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
      ctx.publishRetained(JobRegistryTopic, jobId, { jobId, status: 'completed', result: summary })
    }
    parent.send({ type: '_workerDone', worker: { name: ctx.self.name } })
    return { ...state, pendingSummary: summary ?? failure ?? state.pendingSummary }
  }

  // ── Handlers in dependency order ─────────────────────────────────────────

  // Terminal: drop any late-arriving messages until the supervisor stops us.
  const done: MessageHandler<M, S> = onMessage<M, S>({})

  const abortSession = (
    state:     S,
    ctx:       Ctx,
    errorText: string,
  ) => ({
    state:  finishSession(state, ctx, null, errorText),
    become: done,
    events: [
      emit(OutboundMessageTopic, { clientId, text: JSON.stringify({ type: 'plannerMode', active: false }) }),
      emit(OutboundMessageTopic, { clientId, text: JSON.stringify({ type: 'error', text: errorText }) }),
    ],
  })

  const formalizing: MessageHandler<M, S> = onMessage<M, S>({
    _planWriteDone: (state, msg, ctx) => {
      const summary = state.pendingSummary ?? `Plan saved to ${msg.filepath}.`
      ctx.log.info('planner-session: complete', { jobId, filepath: msg.filepath })
      return {
        state:  finishSession(state, ctx, summary, null),
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
      return {
        state:  finishSession(state, ctx, null, msg.error),
        become: done,
        events: [
          emit(OutboundMessageTopic, { clientId, text: JSON.stringify({ type: 'plannerMode', active: false }) }),
          emit(OutboundMessageTopic, { clientId, text: JSON.stringify({ type: 'error', text: `Failed to save plan: ${msg.error}` }) }),
        ],
      }
    },
  })

  const idle: MessageHandler<M, S> = onMessage<M, S>({
    userMessage: (state, msg, ctx) => {
      if (msg.clientId !== clientId) return { state }
      const userMsg: ApiMessage = { role: 'user', content: msg.text }
      const nextHistory = [...state.history, userMsg]
      ctx.log.info('planner-session: user input while idle', { jobId, text: msg.text.slice(0, 100) })
      const next = sendToLlm({ ...state, history: nextHistory, pending: '' }, ctx, nextHistory)
      return { state: next, become: awaitingLlm }
    },
  })

  const toolLoop: MessageHandler<M, S> = onMessage<M, S>({
    _toolResult: (state, msg, ctx) => {
      const batch     = state.pendingBatch!
      const content   = msg.reply.type === 'toolResult' ? msg.reply.result : `Tool error: ${msg.reply.error}`
      const updated   = [...batch.results, { toolCallId: msg.toolCallId, toolName: msg.toolName, content }]
      const remaining = batch.remaining - 1

      if (remaining > 0) {
        return { state: { ...state, pendingBatch: { ...batch, remaining, results: updated } } }
      }

      const nextLoopCount = state.toolLoopCount + 1
      if (nextLoopCount >= maxToolLoops) {
        ctx.log.warn('planner-session: tool loop limit reached', { jobId })
        return abortSession(state, ctx, 'Tool loop limit reached in planner. Please try again.')
      }

      const toolResultMsgs: ApiMessage[] = updated.map(r => ({
        role: 'tool' as const, content: r.content, tool_call_id: r.toolCallId,
      }))
      const nextHistory: ApiMessage[] = [
        ...batch.messagesAtCall,
        { role: 'assistant' as const, content: null, tool_calls: batch.assistantToolCalls },
        ...toolResultMsgs,
      ]
      const next = sendToLlm({
        ...state,
        history:       nextHistory,
        pending:       '',
        pendingBatch:  null,
        toolLoopCount: nextLoopCount,
      }, ctx, nextHistory)
      return { state: next, become: awaitingLlm }
    },
  })

  // handleToolCalls is only reachable from `awaitingLlm`, so it lives down
  // here where formalizing/toolLoop/abortSession are all in scope.
  const handleToolCalls = (
    state: S,
    msg:   Extract<LlmProviderReply, { type: 'llmToolCalls' }>,
    ctx:   Ctx,
  ) => {
    const { calls } = msg
    const controlCalls  = calls.filter(c =>  CONTROL_TOOL_NAMES.has(c.name))
    const externalCalls = calls.filter(c => !CONTROL_TOOL_NAMES.has(c.name))

    // External research tools
    if (externalCalls.length > 0 && controlCalls.length === 0) {
      const assistantToolCalls: ToolCall[] = externalCalls.map(c => ({
        id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments },
      }))
      const batch: PendingBatch = {
        remaining:      externalCalls.length,
        results:        [],
        messagesAtCall: state.history,
        assistantToolCalls,
      }
      for (const call of externalCalls) {
        const entry = tools[call.name]
        if (!entry) {
          ctx.log.warn('planner-session: unknown external tool', { tool: call.name })
          continue
        }
        ctx.pipeToSelf(
          invokeTool(ctx, entry.ref, { toolName: call.name, arguments: call.arguments, clientId, userId: '' }),
          (reply): M => ({ type: '_toolResult', toolName: call.name, toolCallId: call.id, reply }),
          (error): M => ({ type: '_toolResult', toolName: call.name, toolCallId: call.id, reply: { type: 'toolError', error: String(error) } }),
        )
      }
      return {
        state:  { ...state, requestId: null, pending: '', pendingBatch: batch },
        become: toolLoop,
      }
    }

    // Control tools
    const controlCall = controlCalls[0]
    if (!controlCall) return abortSession(state, ctx, 'Unexpected empty tool call list from planner.')

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
        return abortSession(state, ctx, 'Planner produced an invalid plan format. Please try again.')
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
        (): M => ({ type: '_planWriteDone', filepath }),
        (err): M => ({ type: '_planWriteError', error: String(err) }),
      )
      ctx.log.info('planner-session: formalizing plan', { jobId, filepath, tasks: plan.tasks.length })
      return {
        state: {
          ...state,
          history:        updatedHistory,
          requestId:      null,
          pending:        '',
          pendingSummary: saveSummary,
        },
        become: formalizing,
        events: [emit(OutboundMessageTopic, { clientId, text: JSON.stringify({ type: 'chunk', text: 'Saving your plan…' }) })],
      }
    }

    if (controlCall.name === 'abort_plan') {
      let reason: string = 'Planning session cancelled.'
      try {
        reason = (JSON.parse(controlCall.arguments) as { reason?: string }).reason ?? reason
      } catch {
        reason = controlCall.arguments || reason
      }
      ctx.log.info('planner-session: aborted by user', { jobId, reason })
      return abortSession(state, ctx, reason)
    }

    return abortSession(state, ctx, 'Unexpected tool call from planner LLM.')
  }

  awaitingLlm = onMessage<M, S>({
    llmChunk: (state, msg) => {
      if (msg.requestId !== state.requestId) return { state }
      return { state: { ...state, pending: state.pending + msg.text } }
    },

    llmReasoningChunk: (state) => ({ state }),
    llmImageChunk:     (state) => ({ state }),

    llmToolCalls: (state, msg, ctx) => {
      if (msg.requestId !== state.requestId) return { state }
      return handleToolCalls(state, msg, ctx)
    },

    llmDone: (state, msg) => {
      if (msg.requestId !== state.requestId) return { state }
      const assistantHistory = state.pending
        ? [...state.history, { role: 'assistant' as const, content: state.pending }]
        : state.history
      const events: Emitted[] = []
      if (state.pending) {
        events.push(emit(OutboundMessageTopic, { clientId, text: JSON.stringify({ type: 'chunk', text: state.pending }) }))
        events.push(emit(OutboundMessageTopic, { clientId, text: JSON.stringify({ type: 'done' }) }))
      }
      return {
        state:  { ...state, history: assistantHistory, requestId: null, pending: '' },
        become: idle,
        events,
      }
    },

    llmError: (state, msg, ctx) => {
      if (msg.requestId !== state.requestId) return { state }
      ctx.log.error('planner-session: LLM error', { jobId, error: String(msg.error) })
      return abortSession(state, ctx, 'The planner encountered an error. Please try again.')
    },
  })

  return {
    lifecycle: onLifecycle({
      start: (state, ctx) => {
        ctx.log.info('planner-session: started', { jobId, clientId, goal: goal.slice(0, 100) })
        const next = sendToLlm(state, ctx, state.history)
        return { state: next }
      },
    }),

    // Initial handler: the worker spawns straight into `awaitingLlm` because
    // lifecycle.start has already kicked off the first LLM stream request.
    handler: (state, msg, ctx) => awaitingLlm(state, msg, ctx),
  }
}
