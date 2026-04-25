import { mkdir } from 'node:fs/promises'
import { emit } from '../../system/types.ts'
import type { ActorDef, ActorRef, MessageHandler, ActorResult } from '../../system/types.ts'
import { onLifecycle, onMessage } from '../../system/match.ts'
import { ask } from '../../system/ask.ts'
import { OutboundMessageTopic } from '../../types/events.ts'
import type { ToolCollection, ToolEntry, ToolInvokeMsg, ToolReply } from '../../types/tools.ts'
import type { ApiMessage, LlmProviderMsg, LlmProviderReply, Tool, ToolCall } from '../../types/llm.ts'
import type { Plan, PlannerInputMsg, PlanTask } from './types.ts'
import { PlannerActiveTopic } from './types.ts'

// ─── Options ───

export type PlannerAgentOptions = {
  llmRef:       ActorRef<LlmProviderMsg>
  userContext:  string | null
  tools:        ToolCollection   // pre-filtered research tools from the chatbot
  model:        string
  plansDir:     string
  maxToolLoops: number
  clientId:     string
  userId:       string
  goal:         string
}

// ─── Message protocol ───

export type PlannerMsg =
  | PlannerInputMsg
  | LlmProviderReply
  | { type: '_toolResult';     toolCallId: string; toolName: string; reply: ToolReply }
  | { type: '_planWriteDone';  filepath: string }
  | { type: '_planWriteError'; error: string }

// ─── Internal state types ───

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

// ─── Actor state (mutable session fields only — all config lives in options) ───

export type PlannerAgentState = {
  history:        ApiMessage[]
  requestId:      string | null
  pending:        string
  pendingBatch:   PendingBatch | null
  pendingAskUser: PendingAskUser | null
  toolLoopCount:  number
  proposedPlan:   Plan | null
  pendingSummary: string | null
}

// ─── Internal control tool schemas ───

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

const buildSystemPrompt = (userContext: string | null): string =>
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

Be concise. Research first, then ask only what you genuinely need from the user.` +
  (userContext ? `\n\n---\n\nUser context (use this to make your questions and plan more targeted):\n${userContext}` : '')

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

// ─── Actor ───

export const createPlannerAgentActor = (options: PlannerAgentOptions): ActorDef<PlannerMsg, PlannerAgentState> => {
  const { llmRef, userContext, tools, model, plansDir, maxToolLoops, clientId, userId, goal } = options

  type Result = ActorResult<PlannerMsg, PlannerAgentState>

  let awaitingLlmHandler:    MessageHandler<PlannerMsg, PlannerAgentState>
  let toolLoopHandler:       MessageHandler<PlannerMsg, PlannerAgentState>
  let awaitingUserHandler:   MessageHandler<PlannerMsg, PlannerAgentState>
  let refinementLoopHandler: MessageHandler<PlannerMsg, PlannerAgentState>
  let finalizingHandler:     MessageHandler<PlannerMsg, PlannerAgentState>

  // ─── Shared helpers ───

  const buildTools = (): Tool[] => [
    ASK_USER_TOOL,
    PROPOSE_PLAN_TOOL,
    APPROVE_PLAN_TOOL,
    ABORT_PLAN_TOOL,
    ...Object.values(tools).map((e: ToolEntry) => e.schema as Tool),
  ]

  const sendToLlm = (
    state: PlannerAgentState,
    context: Parameters<MessageHandler<PlannerMsg, PlannerAgentState>>[2],
    messages: ApiMessage[],
  ): string => {
    const requestId = crypto.randomUUID()
    llmRef.send({
      type:     'stream',
      requestId,
      model,
      messages: [{ role: 'system', content: buildSystemPrompt(userContext) }, ...messages],
      tools:    buildTools(),
      role:     'planner',
      clientId,
      replyTo:  context.self as unknown as ActorRef<LlmProviderReply>,
    })
    return requestId
  }

  // ─── Abort session (error path) ───

  type HandlerResult = ReturnType<MessageHandler<PlannerMsg, PlannerAgentState>>

  const abortSession = (
    state: PlannerAgentState,
    context: Parameters<MessageHandler<PlannerMsg, PlannerAgentState>>[2],
    errorText: string,
  ): HandlerResult => {
    context.publishRetained(PlannerActiveTopic, clientId, { clientId, plannerRef: null })
    return {
      state: { ...state },
      events: [
        emit(OutboundMessageTopic, { clientId, text: JSON.stringify({ type: 'plannerMode', active: false }) }),
        emit(OutboundMessageTopic, { clientId, text: JSON.stringify({ type: 'error', text: errorText }) }),
      ],
      become: doneHandler,
    }
  }

  // ─── Common llmToolCalls handler ───

  const handleLlmToolCalls = (
    state: PlannerAgentState,
    msg: Extract<PlannerMsg, { type: 'llmToolCalls' }>,
    context: Parameters<MessageHandler<PlannerMsg, PlannerAgentState>>[2],
  ): HandlerResult => {
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
        messagesAtCall: state.history,
        assistantToolCalls,
      }
      for (const call of externalCalls) {
        const entry = tools[call.name]
        if (!entry) {
          context.log.warn('planner-agent: unknown external tool', { tool: call.name })
          continue
        }
        context.pipeToSelf(
          ask<ToolInvokeMsg, ToolReply>(entry.ref, replyTo => ({
            type: 'invoke', toolName: call.name, arguments: call.arguments, replyTo, clientId, userId,
          })),
          (reply): PlannerMsg => ({ type: '_toolResult', toolName: call.name, toolCallId: call.id, reply }),
          (error): PlannerMsg => ({ type: '_toolResult', toolName: call.name, toolCallId: call.id, reply: { type: 'toolError', error: String(error) } }),
        )
      }
      return {
        state: { ...state, requestId: null, pending: '', pendingBatch: batch },
        become: toolLoopHandler,
      }
    }

    // ── Control tools ──
    const controlCall = controlCalls[0]
    if (!controlCall) return abortSession(state, context, 'Unexpected empty tool call list from planner.')

    const assistantMsg: ApiMessage = {
      role: 'assistant', content: null,
      tool_calls: [{ id: controlCall.id, type: 'function', function: { name: controlCall.name, arguments: controlCall.arguments } }],
    }
    const updatedHistory = [...state.history, assistantMsg]

    // ── ask_user ──
    if (controlCall.name === 'ask_user') {
      let question: string
      try {
        question = (JSON.parse(controlCall.arguments) as { question?: string }).question ?? controlCall.arguments
      } catch {
        question = controlCall.arguments
      }

      context.log.info('planner-agent: asking user', { question: question.slice(0, 100) })

      return {
        state: {
          ...state,
          requestId:      null,
          history:        updatedHistory,
          pending:        '',
          pendingAskUser: { toolCallId: controlCall.id, messagesAtCall: updatedHistory },
        },
        events: [
          emit(OutboundMessageTopic, { clientId, text: JSON.stringify({ type: 'chunk', text: question }) }),
          emit(OutboundMessageTopic, { clientId, text: JSON.stringify({ type: 'done' }) }),
        ],
        become: awaitingUserHandler,
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
        return abortSession(state, context, 'Planner produced an invalid plan format. Please try again.')
      }

      const plan: Plan = {
        id:        crypto.randomUUID(),
        goal,
        context:   summary,
        createdAt: new Date().toISOString(),
        tasks:     rawTasks,
      }

      context.log.info('planner-agent: proposing plan', { tasks: plan.tasks.length })

      return {
        state: {
          ...state,
          requestId:    null,
          history:      updatedHistory,
          pending:      '',
          proposedPlan: plan,
        },
        events: [
          emit(OutboundMessageTopic, { clientId, text: JSON.stringify({ type: 'chunk', text: formatPlanMarkdown(plan) }) }),
          emit(OutboundMessageTopic, { clientId, text: JSON.stringify({ type: 'done' }) }),
        ],
        become: refinementLoopHandler,
      }
    }

    // ── approve_plan ──
    if (controlCall.name === 'approve_plan') {
      const plan = state.proposedPlan
      if (!plan) return abortSession(state, context, 'No plan found to approve.')

      const shortId  = crypto.randomUUID().slice(0, 8)
      const filename = `${todayISO()}-${slugify(plan.goal)}-${shortId}.json`
      const filepath = `${plansDir}/${filename}`
      const summary  = `Goal: ${plan.goal}. ${plan.context} Plan saved to ${filepath} — ${plan.tasks.length} tasks.`

      context.pipeToSelf(
        (async () => {
          await mkdir(plansDir, { recursive: true })
          await Bun.write(filepath, JSON.stringify(plan, null, 2))
        })(),
        (): PlannerMsg => ({ type: '_planWriteDone', filepath }),
        (err): PlannerMsg => ({ type: '_planWriteError', error: String(err) }),
      )

      context.log.info('planner-agent: plan approved, writing to disk', { filepath })

      return {
        state: { ...state, history: updatedHistory, proposedPlan: null, pendingSummary: summary },
        events: [emit(OutboundMessageTopic, { clientId, text: JSON.stringify({ type: 'chunk', text: 'Saving your plan…' }) })],
        become: finalizingHandler,
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
      context.log.info('planner-agent: session aborted by user', { reason })
      return abortSession(state, context, reason) as Result
    }

    return abortSession(state, context, 'Unexpected tool call from planner LLM.')
  }

  // ─── Handler: done (session complete, waiting to be stopped by parent) ───

  const doneHandler: MessageHandler<PlannerMsg, PlannerAgentState> = onMessage<PlannerMsg, PlannerAgentState>({
    _userInput: (state) => ({ state }),   // silently ignore — chatbot will stop this actor soon
  })

  // ─── Handler: awaitingLlm ───

  awaitingLlmHandler = onMessage<PlannerMsg, PlannerAgentState>({
    _userInput: (state): Result => ({ state, stash: true }),

    llmChunk:          (state, msg): Result => msg.requestId !== state.requestId ? { state } : { state: { ...state, pending: state.pending + msg.text } },
    llmReasoningChunk: (state): Result       => ({ state }),
    llmImageChunk:     (state): Result       => ({ state }),

    llmToolCalls: (state, msg, context): Result => {
      if (msg.requestId !== state.requestId) return { state }
      return handleLlmToolCalls(state, msg, context) as Result
    },

    llmDone: (state, msg, context): Result => {
      if (msg.requestId !== state.requestId) return { state }
      // LLM finished without calling a tool — forward text and end session
      context.log.warn('planner-agent: LLM responded without tool call, ending session')
      context.publishRetained(PlannerActiveTopic, clientId, { clientId, plannerRef: null })
      return {
        state,
        events: state.pending
          ? [
              emit(OutboundMessageTopic, { clientId, text: JSON.stringify({ type: 'plannerMode', active: false }) }),
              emit(OutboundMessageTopic, { clientId, text: JSON.stringify({ type: 'chunk', text: state.pending }) }),
              emit(OutboundMessageTopic, { clientId, text: JSON.stringify({ type: 'done' }) }),
            ]
          : [emit(OutboundMessageTopic, { clientId, text: JSON.stringify({ type: 'plannerMode', active: false }) })],
        become: doneHandler,
      }
    },

    llmError: (state, msg, context): Result => {
      if (msg.requestId !== state.requestId) return { state }
      context.log.error('planner-agent: LLM error', { error: String(msg.error) })
      return abortSession(state, context, 'The planner encountered an error. Please try again.') as Result
    },
  })

  // ─── Handler: toolLoop (external research tools in flight) ───

  toolLoopHandler = onMessage<PlannerMsg, PlannerAgentState>({
    _userInput: (state): Result => ({ state, stash: true }),

    _toolResult: (state, msg, context): Result => {
      const batch     = state.pendingBatch!
      const content   = msg.reply.type === 'toolResult' ? msg.reply.result : `Tool error: ${msg.reply.error}`
      const updated   = [...batch.results, { toolCallId: msg.toolCallId, toolName: msg.toolName, content }]
      const remaining = batch.remaining - 1

      if (remaining > 0) {
        return { state: { ...state, pendingBatch: { ...batch, remaining, results: updated } } }
      }

      const nextLoopCount = state.toolLoopCount + 1
      if (nextLoopCount >= maxToolLoops) {
        context.log.warn('planner-agent: tool loop limit reached')
        return abortSession(state, context, 'Tool loop limit reached in planner. Please try again.') as Result
      }

      const toolResultMsgs: ApiMessage[] = updated.map(r => ({
        role: 'tool' as const, content: r.content, tool_call_id: r.toolCallId,
      }))
      const nextHistory: ApiMessage[] = [
        ...batch.messagesAtCall,
        { role: 'assistant' as const, content: null, tool_calls: batch.assistantToolCalls },
        ...toolResultMsgs,
      ]

      const requestId = sendToLlm(state, context, nextHistory)

      return {
        state: {
          ...state,
          requestId,
          history:       nextHistory,
          pending:       '',
          pendingBatch:  null,
          toolLoopCount: nextLoopCount,
        },
        become: awaitingLlmHandler,
      }
    },
  })

  // ─── Handler: awaitingUser (waiting for user's answer to ask_user) ───

  awaitingUserHandler = onMessage<PlannerMsg, PlannerAgentState>({
    _userInput: (state, msg, context): Result => {
      if (msg.clientId !== clientId) return { state }

      const pendingAsk    = state.pendingAskUser!
      const toolResultMsg: ApiMessage = {
        role: 'tool', content: msg.text, tool_call_id: pendingAsk.toolCallId,
      }
      const nextHistory = [...state.history, toolResultMsg]
      const requestId   = sendToLlm(state, context, nextHistory)

      context.log.info('planner-agent: user answered', { answer: msg.text.slice(0, 80) })

      return {
        state: {
          ...state,
          requestId,
          history:        nextHistory,
          pending:        '',
          pendingAskUser: null,
        },
        become: awaitingLlmHandler,
      }
    },
  })

  // ─── Handler: refinementLoop (user reviewing proposed plan) ───

  refinementLoopHandler = onMessage<PlannerMsg, PlannerAgentState>({
    _userInput: (state, msg, context): Result => {
      if (msg.clientId !== clientId) return { state }

      // Forward feedback to LLM for revision, approval (via approve_plan tool), or abortion (via abort_plan tool)
      const feedbackMsg: ApiMessage = { role: 'user', content: `[User feedback on plan]: ${msg.text}` }
      const nextHistory = [...state.history, feedbackMsg]
      const requestId   = sendToLlm(state, context, nextHistory)

      context.log.info('planner-agent: plan feedback', { feedback: msg.text.slice(0, 100) })

      return {
        state: {
          ...state,
          requestId,
          history:      nextHistory,
          pending:      '',
        },
        become: awaitingLlmHandler,
      }
    },
  })

  // ─── Handler: finalizing (async file write in flight) ───

  finalizingHandler = onMessage<PlannerMsg, PlannerAgentState>({
    _userInput: (state): Result => ({ state, stash: true }),

    _planWriteDone: (state, msg, context): Result => {
      const summary = state.pendingSummary ?? `Plan saved to ${msg.filepath}.`

      // Deregister — routing returns to chatbot, chatbot will stop this actor
      context.publishRetained(PlannerActiveTopic, clientId, { clientId, plannerRef: null, summary })
      context.log.info('planner-agent: session complete', { filepath: msg.filepath })

      return {
        state,
        events: [
          emit(OutboundMessageTopic, { clientId, text: JSON.stringify({ type: 'plannerMode', active: false }) }),
          emit(OutboundMessageTopic, { clientId, text: JSON.stringify({ type: 'chunk', text: `\nPlan saved to \`${msg.filepath}\`` }) }),
          emit(OutboundMessageTopic, { clientId, text: JSON.stringify({ type: 'done' }) }),
        ],
        become: doneHandler,
        unstashAll: true,
      }
    },

    _planWriteError: (state, msg, context): Result => {
      context.log.error('planner-agent: failed to write plan', { error: msg.error })
      context.publishRetained(PlannerActiveTopic, clientId, { clientId, plannerRef: null })

      return {
        state,
        events: [
          emit(OutboundMessageTopic, { clientId, text: JSON.stringify({ type: 'plannerMode', active: false }) }),
          emit(OutboundMessageTopic, { clientId, text: JSON.stringify({ type: 'error', text: `Failed to save plan: ${msg.error}` }) }),
        ],
        become: doneHandler,
      }
    },
  })

  return {
    lifecycle: onLifecycle({
      start: (state, context) => {
        // Register session routing immediately
        context.publishRetained(PlannerActiveTopic, clientId, {
          clientId,
          plannerRef: context.self as unknown as ActorRef<PlannerInputMsg>,
        })
        // Kick off the first LLM request
        const userMsg: ApiMessage = { role: 'user', content: goal }
        const history   = [userMsg]
        const requestId = sendToLlm(state, context, history)
        context.log.info('planner-agent: session started', { clientId, goal: goal.slice(0, 100) })
        return { state: { ...state, history, requestId } }
      },
    }),

    handler:       awaitingLlmHandler,
    stashCapacity: 20,
    supervision:   { type: 'restart', maxRetries: 2, withinMs: 30_000 },
  }
}

export const createInitialPlannerAgentState = (): PlannerAgentState => ({
  history:        [],
  requestId:      null,
  pending:        '',
  pendingBatch:   null,
  pendingAskUser: null,
  toolLoopCount:  0,
  proposedPlan:   null,
  pendingSummary: null,
})
