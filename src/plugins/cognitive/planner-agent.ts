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

type SessionBehavior = 'awaitingLlm' | 'toolLoop' | 'awaitingUser' | 'refinementLoop' | 'finalizing' | 'done'

type PendingBatch = {
  remaining:          number
  results:            Array<{ toolCallId: string; toolName: string; content: string }>
  messagesAtCall:     ApiMessage[]
  assistantToolCalls: ToolCall[]
}

type PendingAskUser = {
  toolCallId:     string
  messagesAtCall: ApiMessage[]
}

type PlannerSessionState = {
  behavior:       SessionBehavior
  clientId:       string
  goal:           string
  history:        ApiMessage[]
  requestId:      string | null
  pending:        string
  pendingBatch:   PendingBatch | null
  pendingAskUser: PendingAskUser | null
  toolLoopCount:  number
  proposedPlan:   Plan | null
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

const ASK_USER_TOOL: Tool = {
  type: 'function',
  function: {
    name: 'ask_user',
    description: 'Send a single clarifying question to the user and wait for their response. Use this to gather context you cannot research yourself.',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'The question to ask the user' },
      },
      required: ['question'],
    },
  },
}

const PROPOSE_PLAN_TOOL: Tool = {
  type: 'function',
  function: {
    name: 'propose_plan',
    description: 'Propose a structured plan to the user once you have enough context. The user will either approve it or provide feedback for revision.',
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
              id:                 { type: 'string', description: 'Short unique identifier, e.g. t1, t2' },
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

const APPROVE_PLAN_TOOL: Tool = {
  type: 'function',
  function: {
    name: 'approve_plan',
    description: 'Call this tool when the user explicitly approves the most recently proposed plan.',
    parameters: { type: 'object', properties: {} },
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

const CONTROL_TOOL_NAMES = new Set(['ask_user', 'propose_plan', 'approve_plan', 'abort_plan'])

// ─── System prompt ───

const buildSystemPrompt = (): string =>
  `You are a planning assistant. Your role is to help the user create a detailed, actionable plan for their goal.
Today's date is ${new Date().toDateString()}.

You have access to:
- ask_user: ask the user a clarifying question (one at a time)
- propose_plan: propose a structured task plan once you have enough context
- approve_plan: confirm the user's approval and finalize the plan
- abort_plan: cancel the planning session if the user no longer wishes to proceed
- Research tools (web_search, fetch_file, etc.) to gather information proactively

Process:
1. Research the goal using available research tools to understand what is involved — do this silently before asking questions.
2. Ask the user targeted clarifying questions (one at a time via ask_user) to understand constraints, preferences, and context. Aim for 3–8 questions. Do not ask things you can look up yourself.
3. Once you have enough context, call propose_plan with a structured list of tasks organised as a DAG.
4. The user will approve or provide feedback. 
   - If they approve, call approve_plan.
   - If they provide feedback, incorporate it, ask more questions or call propose_plan again.
   - If they want to cancel, call abort_plan.

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

const formatPlanMarkdown = (plan: Plan): string => {
  const lines: string[] = [
    `**Here is your plan:**`,
    ``,
    `**Goal:** ${plan.goal}`,
    ``,
    plan.context,
    ``,
    `**Tasks:**`,
  ]
  for (const task of plan.tasks) {
    lines.push(``)
    lines.push(`**${task.id}. ${task.name}**`)
    lines.push(task.description)
    lines.push(`✓ Done when: ${task.validationCriteria}`)
    if (task.dependencies.length > 0) {
      lines.push(`↳ Depends on: ${task.dependencies.join(', ')}`)
    }
  }
  lines.push(``)
  lines.push(`---`)
  lines.push(`Let me know if this looks good to save, or if you'd like to make any changes or cancel.`)
  return lines.join('\n')
}

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
  ASK_USER_TOOL,
  PROPOSE_PLAN_TOOL,
  APPROVE_PLAN_TOOL,
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

  // ── ask_user ──
  if (controlCall.name === 'ask_user') {
    let question: string
    try {
      question = (JSON.parse(controlCall.arguments) as { question?: string }).question ?? controlCall.arguments
    } catch {
      question = controlCall.arguments
    }
    ctx.log.info('planner-tool: asking user', { jobId, question: question.slice(0, 100) })
    return {
      state: {
        ...state,
        sessions: { ...state.sessions, [jobId]: { ...updatedSess, behavior: 'awaitingUser', pendingAskUser: { toolCallId: controlCall.id, messagesAtCall: updatedHistory } } },
      },
      sess: { ...updatedSess, behavior: 'awaitingUser', pendingAskUser: { toolCallId: controlCall.id, messagesAtCall: updatedHistory } },
      events: [
        emit(OutboundMessageTopic, { clientId: sess.clientId, text: JSON.stringify({ type: 'chunk', text: question }) }),
        emit(OutboundMessageTopic, { clientId: sess.clientId, text: JSON.stringify({ type: 'done' }) }),
      ],
    }
  }

  // ── propose_plan ──
  if (controlCall.name === 'propose_plan') {
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
    ctx.log.info('planner-tool: proposing plan', { jobId, tasks: plan.tasks.length })
    return {
      state: {
        ...state,
        sessions: { ...state.sessions, [jobId]: { ...updatedSess, behavior: 'refinementLoop', proposedPlan: plan } },
      },
      sess: { ...updatedSess, behavior: 'refinementLoop', proposedPlan: plan },
      events: [
        emit(OutboundMessageTopic, { clientId: sess.clientId, text: JSON.stringify({ type: 'chunk', text: formatPlanMarkdown(plan) }) }),
        emit(OutboundMessageTopic, { clientId: sess.clientId, text: JSON.stringify({ type: 'done' }) }),
      ],
    }
  }

  // ── approve_plan ──
  if (controlCall.name === 'approve_plan') {
    const plan = sess.proposedPlan
    if (!plan) return abortSession(state, sess, ctx, jobId, 'No plan found to approve.')
    const shortId  = crypto.randomUUID().slice(0, 8)
    const filename = `${todayISO()}-${slugify(plan.goal)}-${shortId}.json`
    const filepath = `${state.plansDir}/${filename}`
    const summary  = `Goal: ${plan.goal}. ${plan.context} Plan saved to ${filepath} — ${plan.tasks.length} tasks.`
    ctx.pipeToSelf(
      (async () => {
        await mkdir(state.plansDir, { recursive: true })
        await Bun.write(filepath, JSON.stringify(plan, null, 2))
      })(),
      (): InternalMsg => ({ type: '_planWriteDone', jobId, filepath }),
      (err): InternalMsg => ({ type: '_planWriteError', jobId, error: String(err) }),
    )
    ctx.log.info('planner-tool: plan approved, writing to disk', { jobId, filepath })
    return {
      state: {
        ...state,
        sessions: { ...state.sessions, [jobId]: { ...updatedSess, behavior: 'finalizing', proposedPlan: null, pendingSummary: summary } },
      },
      sess: { ...updatedSess, behavior: 'finalizing', proposedPlan: null, pendingSummary: summary },
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
      // Stash user input while LLM is running
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
      ctx.log.warn('planner-tool: LLM responded without tool call, ending session', { jobId })
      ctx.publishRetained(PlannerActiveTopic, sess.clientId, { clientId: sess.clientId, plannerRef: null })
      const { [sess.clientId]: _, ...clientToJob } = state.clientToJob
      const doneSess: PlannerSessionState = { ...sess, behavior: 'done', pendingSummary: sess.pending || null, requestId: null, pending: '' }
      const events: Emitted[] = [
        emit(OutboundMessageTopic, { clientId: sess.clientId, text: JSON.stringify({ type: 'plannerMode', active: false }) }),
      ]
      if (sess.pending) {
        events.push(emit(OutboundMessageTopic, { clientId: sess.clientId, text: JSON.stringify({ type: 'chunk', text: sess.pending }) }))
        events.push(emit(OutboundMessageTopic, { clientId: sess.clientId, text: JSON.stringify({ type: 'done' }) }))
      }
      return {
        state: { ...state, clientToJob, sessions: { ...state.sessions, [jobId]: doneSess } },
        sess: doneSess,
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

// --- awaitingUser ---

const handleAwaitingUser = (
  state: PlannerToolState,
  sess: PlannerSessionState,
  msg: PlannerToolMsg,
  ctx: Ctx,
  jobId: string,
): SessionResult => {
  if (msg.type !== '_userInput' || msg.clientId !== sess.clientId) {
    return { state, sess, events: [] }
  }

  const pendingAsk    = sess.pendingAskUser!
  const toolResultMsg: ApiMessage = {
    role: 'tool', content: msg.text, tool_call_id: pendingAsk.toolCallId,
  }
  const nextHistory = [...sess.history, toolResultMsg]

  ctx.log.info('planner-tool: user answered', { jobId, answer: msg.text.slice(0, 80) })

  const updatedSess = { ...sess, history: nextHistory, pendingAskUser: null, pending: '' }
  const { state: newState, sess: newSess } = sessionSendToLlm(state, updatedSess, ctx, jobId, nextHistory)
  return {
    state: { ...newState, sessions: { ...newState.sessions, [jobId]: { ...newSess, behavior: 'awaitingLlm' } } },
    sess:  { ...newSess, behavior: 'awaitingLlm' },
    events: [],
  }
}

// --- refinementLoop ---

const handleRefinementLoop = (
  state: PlannerToolState,
  sess: PlannerSessionState,
  msg: PlannerToolMsg,
  ctx: Ctx,
  jobId: string,
): SessionResult => {
  if (msg.type !== '_userInput' || msg.clientId !== sess.clientId) {
    return { state, sess, events: [] }
  }

  const feedbackMsg: ApiMessage = { role: 'user', content: `[User feedback on plan]: ${msg.text}` }
  const nextHistory = [...sess.history, feedbackMsg]

  ctx.log.info('planner-tool: plan feedback', { jobId, feedback: msg.text.slice(0, 100) })

  const updatedSess = { ...sess, history: nextHistory, pending: '' }
  const { state: newState, sess: newSess } = sessionSendToLlm(state, updatedSess, ctx, jobId, nextHistory)
  return {
    state: { ...newState, sessions: { ...newState.sessions, [jobId]: { ...newSess, behavior: 'awaitingLlm' } } },
    sess:  { ...newSess, behavior: 'awaitingLlm' },
    events: [],
  }
}

// --- finalizing ---

const handleFinalizing = (
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
    case 'awaitingLlm':     return handleAwaitingLlm(state, sess, msg, ctx, jobId)
    case 'toolLoop':        return handleToolLoop(state, sess, msg, ctx, jobId)
    case 'awaitingUser':    return handleAwaitingUser(state, sess, msg, ctx, jobId)
    case 'refinementLoop':  return handleRefinementLoop(state, sess, msg, ctx, jobId)
    case 'finalizing':      return handleFinalizing(state, sess, msg, ctx, jobId)
    case 'done':            return { state, sess, events: [] }
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
          pendingAskUser: null,
          toolLoopCount:  0,
          proposedPlan:   null,
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
        if (!sess || sess.behavior !== 'finalizing') return { state }
        const { state: newState, sess: newSess, events } = handleFinalizing(state, sess, msg, ctx, msg.jobId)
        return { state: newState, events }
      },

      _planWriteError: (state, msg, ctx) => {
        const sess = state.sessions[msg.jobId]
        if (!sess || sess.behavior !== 'finalizing') return { state }
        const { state: newState, sess: newSess, events } = handleFinalizing(state, sess, msg, ctx, msg.jobId)
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
