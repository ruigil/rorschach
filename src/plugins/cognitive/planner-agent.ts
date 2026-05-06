import { mkdir } from 'node:fs/promises'
import { emit } from '../../system/types.ts'
import type { ActorDef, ActorRef, ActorContext } from '../../system/types.ts'
import { onLifecycle, onMessage } from '../../system/match.ts'
import { invokeTool } from '../../system/invoke-tool.ts'
import { OutboundMessageTopic } from '../../types/events.ts'
import type { ToolCollection, ToolEntry, ToolFinalReply, ToolFilter, ToolInvokeMsg, ToolJobStatusMsg, ToolReply } from '../../types/tools.ts'
import { applyToolFilter, ToolRegistrationTopic } from '../../types/tools.ts'
import { LlmProviderTopic } from '../../types/llm.ts'
import type { ApiMessage, LlmProviderMsg, LlmProviderReply, Tool, ToolCall } from '../../types/llm.ts'
import type { Plan, PlannerInputMsg, PlanTask } from './types.ts'
import { PlannerActiveTopic } from './types.ts'

// ─── Options ───

export type PlannerToolOptions = {
  model?:       string
  plansDir:     string
  maxToolLoops: number
  toolFilter:   ToolFilter
}

// ─── Plan tool schema ───

export const PLAN_TOOL_SCHEMA: Tool = {
  type: 'function',
  function: {
    name: 'plan',
    description: 'Start a structured planning session for a goal. Use this when the user asks you to create a plan, design a roadmap, or work through a complex multi-step goal.',
    parameters: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: 'Clear description of what needs to be planned' },
      },
      required: ['goal'],
    },
  },
}

// ─── Internal message protocol ───

type InternalMsg =
  | { type: '_toolResult';     jobId: string; toolCallId: string; toolName: string; reply: ToolFinalReply }
  | { type: '_planWriteDone';  jobId: string; filepath: string }
  | { type: '_planWriteError'; jobId: string; error: string }

export type PlannerToolMsg = ToolInvokeMsg | ToolJobStatusMsg | PlannerInputMsg | LlmProviderReply | InternalMsg

// ─── Session state types ───

type SessionBehavior = 'awaitingLlm' | 'toolLoop' | 'idle' | 'formalizing' | 'done'

type PendingBatch = {
  remaining:          number
  results:            Array<{ toolCallId: string; toolName: string; content: string }>
  messagesAtCall:     ApiMessage[]
  assistantToolCalls: ToolCall[]
}

type PlannerSessionState = {
  behavior:       SessionBehavior
  clientId:       string
  goal:           string
  history:        ApiMessage[]
  requestId:      string | null
  pending:        string
  pendingBatch:   PendingBatch | null
  toolLoopCount:  number
  pendingSummary: string | null
}

// ─── Planner tool (multi-session) state ───

export type PlannerToolState = {
  sessions:    Record<string, PlannerSessionState>  // jobId → session
  clientToJob: Record<string, string>               // clientId → jobId
  requestToJob: Record<string, string>              // requestId → jobId
  llmRef:      ActorRef<LlmProviderMsg> | null
  tools:       ToolCollection
  model:       string
  plansDir:    string
  maxToolLoops: number
}

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
2. Ask the user clarifying questions directly in your response — be conversational. You do not need a special tool for questions. Aim for a few targeted questions to understand constraints, preferences, and context.
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

// ─── Event helper ───

type Emitted = ReturnType<typeof emit>

// ─── Per-session helpers ────────────────────────────────────────────────

type Ctx = ActorContext<PlannerToolMsg>

const sessionSendToLlm = (
  state: PlannerToolState,
  sess: PlannerSessionState,
  ctx: Ctx,
  jobId: string,
  messages: ApiMessage[],
): { state: PlannerToolState; sess: PlannerSessionState } => {
  if (!state.llmRef) {
    ctx.log.warn('planner-tool: no LLM ref, cannot send', { jobId })
    return { state, sess }
  }
  const requestId = crypto.randomUUID()
  state.llmRef.send({
    type:     'stream',
    requestId,
    model:    state.model,
    messages: [{ role: 'system', content: buildSystemPrompt() }, ...messages],
    tools:    buildTools(state),
    role:     'planner',
    clientId: sess.clientId,
    replyTo:  ctx.self as unknown as ActorRef<LlmProviderReply>,
  })
  return {
    state: { ...state, requestToJob: { ...state.requestToJob, [requestId]: jobId } },
    sess:  { ...sess, requestId },
  }
}

const buildTools = (state: PlannerToolState): Tool[] => [
  FORMALIZE_PLAN_TOOL,
  ABORT_PLAN_TOOL,
  ...Object.values(state.tools).map((e: ToolEntry) => e.schema as Tool),
]

// ─── Abort session ───

type SessionResult = {
  state: PlannerToolState
  sess:   PlannerSessionState
  events: Emitted[]
}

const abortSession = (
  state: PlannerToolState,
  sess: PlannerSessionState,
  ctx: Ctx,
  jobId: string,
  errorText: string,
): SessionResult => {
  const clientId = sess.clientId
  const { [clientId]: _, ...clientToJob } = state.clientToJob
  const updatedState: PlannerToolState = {
    ...state,
    clientToJob,
    sessions: { ...state.sessions, [jobId]: { ...sess, behavior: 'done', pendingSummary: errorText } },
  }
  return {
    state: updatedState,
    sess:  { ...sess, behavior: 'done', pendingSummary: errorText },
    events: [
      emit(OutboundMessageTopic, { clientId, text: JSON.stringify({ type: 'plannerMode', active: false }) }),
      emit(OutboundMessageTopic, { clientId, text: JSON.stringify({ type: 'error', text: errorText }) }),
    ],
  }
}

// ─── Handle LLM tool calls ───

const handleSessionToolCalls = (
  state: PlannerToolState,
  sess: PlannerSessionState,
  msg: Extract<LlmProviderReply, { type: 'llmToolCalls' }>,
  ctx: Ctx,
  jobId: string,
): SessionResult => {
  const { calls } = msg

  const controlCalls  = calls.filter(c => CONTROL_TOOL_NAMES.has(c.name))
  const externalCalls = calls.filter(c => !CONTROL_TOOL_NAMES.has(c.name))

  // ── External research tools ──
  if (externalCalls.length > 0 && controlCalls.length === 0) {
    const assistantToolCalls: ToolCall[] = externalCalls.map(c => ({
      id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments },
    }))
    const batch: PendingBatch = {
      remaining:      externalCalls.length,
      results:        [],
      messagesAtCall: sess.history,
      assistantToolCalls,
    }
    for (const call of externalCalls) {
      const entry = state.tools[call.name]
      if (!entry) {
        ctx.log.warn('planner-tool: unknown external tool', { tool: call.name })
        continue
      }
      ctx.pipeToSelf(
        invokeTool(ctx, entry.ref, { toolName: call.name, arguments: call.arguments, clientId: sess.clientId, userId: '' }),
        (reply): InternalMsg => ({ type: '_toolResult', jobId, toolName: call.name, toolCallId: call.id, reply }),
        (error): InternalMsg => ({ type: '_toolResult', jobId, toolName: call.name, toolCallId: call.id, reply: { type: 'toolError', error: String(error) } }),
      )
    }
    return {
      state: { ...state, sessions: { ...state.sessions, [jobId]: { ...sess, behavior: 'toolLoop', pendingBatch: batch } } },
      sess:  { ...sess, behavior: 'toolLoop', requestId: null, pending: '', pendingBatch: batch },
      events: [],
    }
  }

  // ── Control tools ──
  const controlCall = controlCalls[0]
  if (!controlCall) return abortSession(state, sess, ctx, jobId, 'Unexpected empty tool call list from planner.')

  const assistantMsg: ApiMessage = {
    role: 'assistant', content: null,
    tool_calls: [{ id: controlCall.id, type: 'function', function: { name: controlCall.name, arguments: controlCall.arguments } }],
  }
  const updatedHistory = [...sess.history, assistantMsg]
  const updatedSess = { ...sess, history: updatedHistory, requestId: null as string | null, pending: '' }

  // ── formalize_plan ──
  if (controlCall.name === 'formalize_plan') {
    let summary: string
    let rawTasks: PlanTask[]
    try {
      const args = JSON.parse(controlCall.arguments) as { summary?: string; tasks?: PlanTask[] }
      summary  = args.summary ?? ''
      rawTasks = args.tasks   ?? []
    } catch {
      return abortSession(state, sess, ctx, jobId, 'Planner produced an invalid plan format. Please try again.')
    }
    const plan: Plan = {
      id:        crypto.randomUUID(),
      goal:      sess.goal,
      context:   summary,
      createdAt: new Date().toISOString(),
      tasks:     rawTasks,
    }
    const shortId  = crypto.randomUUID().slice(0, 8)
    const filename = `${todayISO()}-${slugify(plan.goal)}-${shortId}.json`
    const filepath = `${state.plansDir}/${filename}`
    const saveSummary = `Goal: ${plan.goal}. ${plan.context} Plan saved to ${filepath} — ${plan.tasks.length} tasks.`
    ctx.pipeToSelf(
      (async () => {
        await mkdir(state.plansDir, { recursive: true })
        await Bun.write(filepath, JSON.stringify(plan, null, 2))
      })(),
      (): InternalMsg => ({ type: '_planWriteDone', jobId, filepath }),
      (err): InternalMsg => ({ type: '_planWriteError', jobId, error: String(err) }),
    )
    ctx.log.info('planner-tool: formalizing plan', { jobId, filepath, tasks: plan.tasks.length })
    return {
      state: {
        ...state,
        sessions: { ...state.sessions, [jobId]: { ...updatedSess, behavior: 'formalizing', pendingSummary: saveSummary } },
      },
      sess: { ...updatedSess, behavior: 'formalizing', pendingSummary: saveSummary },
      events: [emit(OutboundMessageTopic, { clientId: sess.clientId, text: JSON.stringify({ type: 'chunk', text: 'Saving your plan…' }) })],
    }
  }

  // ── abort_plan ──
  if (controlCall.name === 'abort_plan') {
    let reason: string = 'Planning session cancelled.'
    try {
      reason = (JSON.parse(controlCall.arguments) as { reason?: string }).reason ?? reason
    } catch {
      reason = controlCall.arguments || reason
    }
    ctx.log.info('planner-tool: session aborted by user', { jobId, reason })
    return abortSession(state, sess, ctx, jobId, reason)
  }

  return abortSession(state, sess, ctx, jobId, 'Unexpected tool call from planner LLM.')
}

// ─── Session behavior handlers ──────────────────────────────────────────

// --- awaitingLlm ---

const handleAwaitingLlm = (
  state: PlannerToolState,
  sess: PlannerSessionState,
  msg: PlannerToolMsg,
  ctx: Ctx,
  jobId: string,
): SessionResult => {
  switch (msg.type) {
    case '_userInput': {
      // Drop user input while LLM is actively generating
      return { state: { ...state, sessions: { ...state.sessions, [jobId]: sess } }, sess, events: [] }
    }

    case 'llmChunk': {
      if (msg.requestId !== sess.requestId) return { state, sess, events: [] }
      const updatedSess = { ...sess, pending: sess.pending + msg.text }
      return { state: { ...state, sessions: { ...state.sessions, [jobId]: updatedSess } }, sess: updatedSess, events: [] }
    }

    case 'llmReasoningChunk':
    case 'llmImageChunk': {
      return { state, sess, events: [] }
    }

    case 'llmToolCalls': {
      if (msg.requestId !== sess.requestId) return { state, sess, events: [] }
      return handleSessionToolCalls(state, sess, msg, ctx, jobId)
    }

    case 'llmDone': {
      if (msg.requestId !== sess.requestId) return { state, sess, events: [] }
      // Append the assistant's pending text as a history message, then go idle
      const assistantHistory = sess.pending
        ? [...sess.history, { role: 'assistant' as const, content: sess.pending }]
        : sess.history
      const idleSess: PlannerSessionState = { ...sess, behavior: 'idle', history: assistantHistory, requestId: null, pending: '' }
      const events: Emitted[] = []
      if (sess.pending) {
        events.push(emit(OutboundMessageTopic, { clientId: sess.clientId, text: JSON.stringify({ type: 'chunk', text: sess.pending }) }))
        events.push(emit(OutboundMessageTopic, { clientId: sess.clientId, text: JSON.stringify({ type: 'done' }) }))
      }
      return {
        state: { ...state, sessions: { ...state.sessions, [jobId]: idleSess } },
        sess: idleSess,
        events,
      }
    }

    case 'llmError': {
      if (msg.requestId !== sess.requestId) return { state, sess, events: [] }
      ctx.log.error('planner-tool: LLM error', { jobId, error: String(msg.error) })
      return abortSession(state, sess, ctx, jobId, 'The planner encountered an error. Please try again.')
    }

    default:
      return { state, sess, events: [] }
  }
}

// --- toolLoop ---

const handleToolLoop = (
  state: PlannerToolState,
  sess: PlannerSessionState,
  msg: PlannerToolMsg,
  ctx: Ctx,
  jobId: string,
): SessionResult => {
  switch (msg.type) {
    case '_userInput': {
      // Stash user input while tools are running
      return { state: { ...state, sessions: { ...state.sessions, [jobId]: sess } }, sess, events: [] }
    }

    case '_toolResult': {
      if (msg.jobId !== jobId) return { state, sess, events: [] }
      const batch     = sess.pendingBatch!
      const content   = msg.reply.type === 'toolResult' ? msg.reply.result : `Tool error: ${msg.reply.error}`
      const updated   = [...batch.results, { toolCallId: msg.toolCallId, toolName: msg.toolName, content }]
      const remaining = batch.remaining - 1

      if (remaining > 0) {
        const updatedSess = { ...sess, pendingBatch: { ...batch, remaining, results: updated } }
        return { state: { ...state, sessions: { ...state.sessions, [jobId]: updatedSess } }, sess: updatedSess, events: [] }
      }

      const nextLoopCount = sess.toolLoopCount + 1
      if (nextLoopCount >= state.maxToolLoops) {
        ctx.log.warn('planner-tool: tool loop limit reached', { jobId })
        return abortSession(state, sess, ctx, jobId, 'Tool loop limit reached in planner. Please try again.')
      }

      const toolResultMsgs: ApiMessage[] = updated.map(r => ({
        role: 'tool' as const, content: r.content, tool_call_id: r.toolCallId,
      }))
      const nextHistory: ApiMessage[] = [
        ...batch.messagesAtCall,
        { role: 'assistant' as const, content: null, tool_calls: batch.assistantToolCalls },
        ...toolResultMsgs,
      ]

      const updatedSess = { ...sess, history: nextHistory, pendingBatch: null, pending: '', toolLoopCount: nextLoopCount }
      const { state: newState, sess: newSess } = sessionSendToLlm(state, updatedSess, ctx, jobId, nextHistory)
      return {
        state: { ...newState, sessions: { ...newState.sessions, [jobId]: { ...newSess, behavior: 'awaitingLlm' } } },
        sess:  { ...newSess, behavior: 'awaitingLlm' },
        events: [],
      }
    }

    default:
      return { state, sess, events: [] }
  }
}

// --- idle ---

const handleIdle = (
  state: PlannerToolState,
  sess: PlannerSessionState,
  msg: PlannerToolMsg,
  ctx: Ctx,
  jobId: string,
): SessionResult => {
  if (msg.type !== '_userInput' || msg.clientId !== sess.clientId) {
    return { state, sess, events: [] }
  }

  const userMsg: ApiMessage = { role: 'user', content: msg.text }
  const nextHistory = [...sess.history, userMsg]

  ctx.log.info('planner-tool: user input while idle', { jobId, text: msg.text.slice(0, 100) })

  const updatedSess = { ...sess, history: nextHistory, pending: '' }
  const { state: newState, sess: newSess } = sessionSendToLlm(state, updatedSess, ctx, jobId, nextHistory)
  return {
    state: { ...newState, sessions: { ...newState.sessions, [jobId]: { ...newSess, behavior: 'awaitingLlm' } } },
    sess:  { ...newSess, behavior: 'awaitingLlm' },
    events: [],
  }
}

// --- formalizing ---

const handleFormalizing = (
  state: PlannerToolState,
  sess: PlannerSessionState,
  msg: PlannerToolMsg,
  ctx: Ctx,
  jobId: string,
): SessionResult => {
  switch (msg.type) {
    case '_userInput': {
      return { state: { ...state, sessions: { ...state.sessions, [jobId]: sess } }, sess, events: [] }
    }

    case '_planWriteDone': {
      if (msg.jobId !== jobId) return { state, sess, events: [] }
      const summary = sess.pendingSummary ?? `Plan saved to ${msg.filepath}.`
      ctx.publishRetained(PlannerActiveTopic, sess.clientId, { clientId: sess.clientId, plannerRef: null, summary })
      ctx.log.info('planner-tool: session complete', { jobId, filepath: msg.filepath })
      const { [sess.clientId]: _, ...clientToJob } = state.clientToJob
      const doneSess: PlannerSessionState = { ...sess, behavior: 'done', pendingSummary: summary }
      return {
        state: { ...state, clientToJob, sessions: { ...state.sessions, [jobId]: doneSess } },
        sess: doneSess,
        events: [
          emit(OutboundMessageTopic, { clientId: sess.clientId, text: JSON.stringify({ type: 'plannerMode', active: false }) }),
          emit(OutboundMessageTopic, { clientId: sess.clientId, text: JSON.stringify({ type: 'chunk', text: `\nPlan saved to \`${msg.filepath}\`` }) }),
          emit(OutboundMessageTopic, { clientId: sess.clientId, text: JSON.stringify({ type: 'done' }) }),
        ],
      }
    }

    case '_planWriteError': {
      if (msg.jobId !== jobId) return { state, sess, events: [] }
      ctx.log.error('planner-tool: failed to write plan', { jobId, error: msg.error })
      ctx.publishRetained(PlannerActiveTopic, sess.clientId, { clientId: sess.clientId, plannerRef: null })
      const { [sess.clientId]: _, ...clientToJob } = state.clientToJob
      const doneSess: PlannerSessionState = { ...sess, behavior: 'done', pendingSummary: `Failed to save plan: ${msg.error}` }
      return {
        state: { ...state, clientToJob, sessions: { ...state.sessions, [jobId]: doneSess } },
        sess: doneSess,
        events: [
          emit(OutboundMessageTopic, { clientId: sess.clientId, text: JSON.stringify({ type: 'plannerMode', active: false }) }),
          emit(OutboundMessageTopic, { clientId: sess.clientId, text: JSON.stringify({ type: 'error', text: `Failed to save plan: ${msg.error}` }) }),
        ],
      }
    }

    default:
      return { state, sess, events: [] }
  }
}

// ─── Session dispatch ───────────────────────────────────────────────────

const dispatchSession = (
  state: PlannerToolState,
  sess: PlannerSessionState,
  msg: PlannerToolMsg,
  ctx: Ctx,
  jobId: string,
): SessionResult => {
  switch (sess.behavior) {
    case 'awaitingLlm': return handleAwaitingLlm(state, sess, msg, ctx, jobId)
    case 'toolLoop':    return handleToolLoop(state, sess, msg, ctx, jobId)
    case 'idle':        return handleIdle(state, sess, msg, ctx, jobId)
    case 'formalizing': return handleFormalizing(state, sess, msg, ctx, jobId)
    case 'done':        return { state, sess, events: [] }
  }
}

// ─── Actor definition ───────────────────────────────────────────────────

export const createPlannerToolActor = (options: PlannerToolOptions): ActorDef<PlannerToolMsg, PlannerToolState> => {
  const { model = 'google/gemini-2.5-flash-lite-preview', plansDir, maxToolLoops, toolFilter } = options

  return {
    lifecycle: onLifecycle({
      start: (state, ctx) => {
        ctx.subscribe(LlmProviderTopic, (event) => {
          state.llmRef = event.ref
          return null // no message — just update state via closure
        })

        ctx.subscribe(ToolRegistrationTopic, (event) => {
          if (!applyToolFilter(event.name, toolFilter)) return null
          if (event.ref === null) {
            const { [event.name]: _, ...tools } = state.tools
            state.tools = tools
            return null
          }
          state.tools = { ...state.tools, [event.name]: { schema: event.schema, ref: event.ref, mayBeLongRunning: event.mayBeLongRunning } }
          return null
        })

        ctx.log.info('planner-tool: started', { model, plansDir, maxToolLoops })
        return {
          state: {
            ...state,
            model,
            plansDir,
            maxToolLoops,
          },
        }
      },
    }),

    handler: onMessage<PlannerToolMsg, PlannerToolState>({
      invoke: (state, msg, ctx) => {
        let goal: string
        try { goal = (JSON.parse(msg.arguments) as { goal?: string }).goal ?? msg.arguments }
        catch { goal = msg.arguments }

        const jobId      = crypto.randomUUID()
        const clientId   = msg.clientId ?? 'unknown'
        const sess: PlannerSessionState = {
          behavior:       'awaitingLlm',
          clientId,
          goal,
          history:        [],
          requestId:      null,
          pending:        '',
          pendingBatch:   null,
          toolLoopCount:  0,
          pendingSummary: null,
        }

        // Register session routing before replying toolPending
        ctx.publishRetained(PlannerActiveTopic, clientId, {
          clientId,
          plannerRef: ctx.self as unknown as ActorRef<PlannerInputMsg>,
        })

        // Kick off first LLM request
        const userMsg: ApiMessage = { role: 'user', content: goal }
        const { state: updatedState, sess: updatedSess } = sessionSendToLlm(
          state, { ...sess, history: [userMsg] }, ctx, jobId, [userMsg],
        )

        // Reply toolPending so invokeTool starts polling
        msg.replyTo.send({
          type: 'toolPending',
          jobId,
          placeholderText: 'Planning session started.',
          pollIntervalMs: 15000,
        })

        ctx.log.info('planner-tool: session started', { jobId, clientId, goal: goal.slice(0, 100) })

        return {
          state: {
            ...updatedState,
            sessions:    { ...updatedState.sessions,    [jobId]: updatedSess },
            clientToJob: { ...updatedState.clientToJob, [clientId]: jobId },
          },
        }
      },

      jobStatus: (state, msg, ctx) => {
        const sess = state.sessions[msg.jobId]
        if (!sess) {
          msg.replyTo.send({ type: 'toolError', error: `No active planning session with jobId ${msg.jobId}.` })
          return { state }
        }
        if (sess.behavior === 'done') {
          msg.replyTo.send({ type: 'toolResult', result: sess.pendingSummary ?? 'Planning session completed.' })
          // Clean up session
          const { [msg.jobId]: _, ...sessions } = state.sessions
          const clientToJob = Object.fromEntries(Object.entries(state.clientToJob).filter(([, id]) => id !== msg.jobId))
          return { state: { ...state, sessions, clientToJob } }
        }
        msg.replyTo.send({ type: 'toolPending', jobId: msg.jobId })
        return { state }
      },

      _userInput: (state, msg, ctx) => {
        const jobId = state.clientToJob[msg.clientId]
        if (!jobId) return { state }
        const sess = state.sessions[jobId]
        if (!sess) return { state }
        const { state: newState, sess: newSess, events } = dispatchSession(state, sess, msg, ctx, jobId)
        return {
          state: newState,
          events,
        }
      },

      llmChunk: (state, msg, ctx) => {
        const jobId = state.requestToJob[msg.requestId]
        if (!jobId) return { state }
        const sess = state.sessions[jobId]
        if (!sess || sess.behavior !== 'awaitingLlm') return { state }
        const { state: newState, sess: newSess } = handleAwaitingLlm(state, sess, msg, ctx, jobId)
        return { state: newState }
      },

      llmReasoningChunk: (state) => ({ state }),
      llmImageChunk: (state) => ({ state }),

      llmToolCalls: (state, msg, ctx) => {
        const jobId = state.requestToJob[msg.requestId]
        if (!jobId) return { state }
        const sess = state.sessions[jobId]
        if (!sess || sess.behavior !== 'awaitingLlm') return { state }
        const { state: newState, sess: newSess, events } = handleAwaitingLlm(state, sess, msg, ctx, jobId)
        return { state: newState, events }
      },

      llmDone: (state, msg, ctx) => {
        const jobId = state.requestToJob[msg.requestId]
        if (!jobId) return { state }
        const sess = state.sessions[jobId]
        if (!sess || sess.behavior !== 'awaitingLlm') return { state }
        const { state: newState, sess: newSess, events } = handleAwaitingLlm(state, sess, msg, ctx, jobId)
        return {
          state: { ...newState },
          events,
        }
      },

      llmError: (state, msg, ctx) => {
        const jobId = state.requestToJob[msg.requestId]
        if (!jobId) return { state }
        const sess = state.sessions[jobId]
        if (!sess || sess.behavior !== 'awaitingLlm') return { state }
        const { state: newState, sess: newSess, events } = handleAwaitingLlm(state, sess, msg, ctx, jobId)
        return { state: newState, events }
      },

      _toolResult: (state, msg, ctx) => {
        const sess = state.sessions[msg.jobId]
        if (!sess || sess.behavior !== 'toolLoop') return { state }
        const { state: newState, sess: newSess, events } = handleToolLoop(state, sess, msg, ctx, msg.jobId)
        return { state: newState, events }
      },

      _planWriteDone: (state, msg, ctx) => {
        const sess = state.sessions[msg.jobId]
        if (!sess || sess.behavior !== 'formalizing') return { state }
        const { state: newState, sess: newSess, events } = handleFormalizing(state, sess, msg, ctx, msg.jobId)
        return { state: newState, events }
      },

      _planWriteError: (state, msg, ctx) => {
        const sess = state.sessions[msg.jobId]
        if (!sess || sess.behavior !== 'formalizing') return { state }
        const { state: newState, sess: newSess, events } = handleFormalizing(state, sess, msg, ctx, msg.jobId)
        return { state: newState, events }
      },
    }),

    supervision: { type: 'restart', maxRetries: 2, withinMs: 30_000 },
  }
}

export const createInitialPlannerToolState = (): PlannerToolState => ({
  sessions:     {},
  clientToJob:  {},
  requestToJob: {},
  llmRef:       null,
  tools:        {},
  model:        '',
  plansDir:     '',
  maxToolLoops: 10,
})
