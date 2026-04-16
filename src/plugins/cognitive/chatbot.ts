import { emit } from '../../system/types.ts'
import type { ActorDef, ActorRef, MessageHandler, PersistenceAdapter, SpanHandle, ActorResult } from '../../system/types.ts'
import { ask } from '../../system/ask.ts'
import { onLifecycle, onMessage } from '../../system/match.ts'
import { WsSendTopic, MemoryStreamTopic } from '../../types/ws.ts'
import type { ToolCollection, ToolEntry, ToolFilter, ToolInvokeMsg, ToolReply } from '../../types/tools.ts'
import { applyToolFilter, ToolRegistrationTopic } from '../../types/tools.ts'
import { LlmProviderTopic } from '../../types/llm.ts'
import type {
  ApiMessage,
  LlmProviderMsg,
  LlmProviderReply,
  TokenUsage,
  Tool,
  ToolCall,
} from '../../types/llm.ts'
import type { ChatbotMsg } from '../../types/chatbot.ts'
import { UserContextTopic } from '../../types/memory.ts'
import type { PlannerConfig, PlannerInputMsg } from '../../types/planner.ts'
import { createPlannerAgentActor, createInitialPlannerAgentState } from './planner-agent.ts'

// ─── State ───

type ConversationMessage =
  | { role: 'user';      content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool';      content: string; tool_call_id: string }

type PendingBatch = {
  remaining:          number
  results:            Array<{ toolCallId: string; toolName: string; content: string }>
  messagesAtCall:     ApiMessage[]
  assistantToolCalls: ToolCall[]
}

type SpanHandles = {
  requestSpan: import('../../system/types.ts').SpanHandle
  llmSpan?:    import('../../system/types.ts').SpanHandle
  toolSpans:   Record<string, import('../../system/types.ts').SpanHandle>
}

export type ChatbotState = {
  // Permanent
  history:          ConversationMessage[]
  tools:            ToolCollection
  sessionUsage:     TokenUsage
  llmRef:           ActorRef<LlmProviderMsg> | null
  userContext:      string | null
  activePlannerRef: ActorRef<PlannerInputMsg> | null
  activeClientId:   string   // updated per userMessage to route responses to current sender

  // Active turn (set on userMessage, cleared on llmDone/llmError)
  requestId:        string | null
  turnMessages:     ApiMessage[] | null
  spanHandles:      SpanHandles | null
  pendingUsage:     TokenUsage
  pending:          string
  pendingReasoning: string

  // Active tool batch (set on llmToolCalls, cleared when all results arrive)
  pendingBatch:     PendingBatch | null
  toolLoopCount:    number
}

// ─── History markers note ───
// Baked into every system prompt so the LLM correctly interprets synthetic history entries.
const HISTORY_MARKERS_NOTE =
  'Messages prefixed with [Internal Instruction] in the conversation history are past internal ' +
  'instructions that you already carried out. Do not act on them again.\n' +
  'Messages prefixed with [Planning session completed] mark the end of a past background ' +
  'planning session. They are historical context — do not start a new planning session because ' +
  'of them. Only plan again if the user explicitly asks you to.'

// ─── Options ───

export type ChatbotActorOptions = {
  clientId:       string
  model:          string
  systemPrompt?:  string
  historyWindow?: number
  toolFilter?:    ToolFilter
  plannerConfig?: PlannerConfig
  maxToolLoops?:  number
  userId?:        string | null
  roles?:         string[]
  llmRef?:        ActorRef<LlmProviderMsg> | null
}

// ─── Plan tool schema ───

const PLAN_TOOL_SCHEMA: Tool = {
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

// ─── Helpers ───

const trimHistory = (history: ConversationMessage[], maxTurns: number): ConversationMessage[] => {
  const userIndices = history.reduce<number[]>((acc, m, i) => { if (m.role === 'user') acc.push(i); return acc }, [])
  if (userIndices.length <= maxTurns) return history
  return history.slice(userIndices[userIndices.length - maxTurns])
}

const filterTools = (tools: ToolCollection, filter?: ToolFilter): ToolCollection =>
  filter ? Object.fromEntries(Object.entries(tools).filter(([name]) => applyToolFilter(name, filter))) : tools

// ─── Persistence ───
//
// Only the durable fields are saved. Ephemeral turn state and ActorRefs are
// always reset to defaults on load — they are restored via subscriptions at startup.

type PersistedChatbotState = {
  history:     ConversationMessage[]
  userContext: string | null
}

// Drop any incomplete turn at the tail (e.g. a user message without a reply,
// or a mid-tool-loop assistant turn) so the history is always clean on restart.
const sanitizeHistory = (history: ConversationMessage[]): ConversationMessage[] => {
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i]!
    if (m.role === 'assistant' && typeof m.content === 'string') return history.slice(0, i + 1)
  }
  return []
}

const createPersistence = (userId: string, clientId: string, llmRef: ActorRef<LlmProviderMsg> | null): PersistenceAdapter<ChatbotState> => {
  const path = `workspace/history/${userId}.json`
  return {
    load: async () => {
      const file = Bun.file(path)
      if (!await file.exists()) return undefined
      const saved = JSON.parse(await file.text()) as PersistedChatbotState
      return {
        history:          sanitizeHistory(saved.history ?? []),
        sessionUsage:     { promptTokens: 0, completionTokens: 0 },
        userContext:      saved.userContext ?? null,
        // Ephemeral fields — reset to defaults; restored via subscriptions on start
        tools:            {},
        llmRef,
        activePlannerRef: null,
        activeClientId:   clientId,
        requestId:        null,
        turnMessages:     null,
        spanHandles:      null,
        pendingUsage:     { promptTokens: 0, completionTokens: 0 },
        pending:          '',
        pendingReasoning: '',
        pendingBatch:     null,
        toolLoopCount:    0,
      }
    },
    save: async (state) => {
      const data: PersistedChatbotState = { history: state.history, userContext: state.userContext }
      await Bun.write(path, JSON.stringify(data, null, 2))
    },
  }
}

// ─── Actor definition ───

export const createChatbotActor = (options: ChatbotActorOptions): ActorDef<ChatbotMsg, ChatbotState> => {
  const { clientId, model, systemPrompt, historyWindow, toolFilter, plannerConfig, maxToolLoops = 25, userId, llmRef: initialLlmRef = null } = options

  type Result = ActorResult<ChatbotMsg, ChatbotState>

  // ─── Shared handlers (used across all behaviors) ───

  const toolRegistered = (state: ChatbotState, msg: Extract<ChatbotMsg, { type: '_toolRegistered' }>): { state: ChatbotState } => ({
    state: { ...state, tools: { ...state.tools, [msg.name]: { schema: msg.schema, ref: msg.ref } } },
  })

  const toolUnregistered = (state: ChatbotState, msg: Extract<ChatbotMsg, { type: '_toolUnregistered' }>): { state: ChatbotState } => {
    const { [msg.name]: _, ...rest } = state.tools
    return { state: { ...state, tools: rest } }
  }

  const llmProviderUpdated = (state: ChatbotState, msg: Extract<ChatbotMsg, { type: '_llmProviderUpdated' }>): { state: ChatbotState } => ({
    state: { ...state, llmRef: msg.ref },
  })

  // ─── Forward declarations for circular references ───

  let awaitingLlmHandler: MessageHandler<ChatbotMsg, ChatbotState>
  let toolLoopHandler: MessageHandler<ChatbotMsg, ChatbotState>

  // ─── Handler: idle — waiting for user input ───

  const idleHandler: MessageHandler<ChatbotMsg, ChatbotState> = onMessage<ChatbotMsg, ChatbotState>({
    userMessage: (state, message, context): Result => {
      const { clientId: msgClientId, text, images, audio, pdfs, traceId, parentSpanId, isCron } = message
      const activeClientId = msgClientId
      const todayDateNote = `Today's date is ${new Date().toDateString()}.`
      const fullSystemPrompt = [systemPrompt, todayDateNote, state.userContext, HISTORY_MARKERS_NOTE].filter(Boolean).join('\n\n---\n\n')
      const requestSpan = context.trace.child(traceId, parentSpanId, 'chatbot', { preview: text.slice(0, 80) })
      const llmSpan = context.trace.child(requestSpan.traceId, requestSpan.spanId, 'llm-call', { model })
      const toolSchemas = [
        ...Object.values(state.tools).map((e: ToolEntry) => e.schema as Tool),
        ...(plannerConfig ? [PLAN_TOOL_SCHEMA] : []),
      ]
      const tools = toolSchemas.length > 0 ? toolSchemas : undefined
      const requestId = crypto.randomUUID()

      if (isCron) {
        // Cron prompts are instructions to the LLM to initiate a message to the user.
        // Inject as a system task — do NOT add to history as a user message, so the
        // conversation reads naturally (assistant speaks first, user responds).
        const apiMessages: ApiMessage[] = [
          ...(fullSystemPrompt ? [{ role: 'system' as const, content: fullSystemPrompt }] : []),
          ...state.history,
          { role: 'user' as const, content: `[Internal Instruction — do not mention that this is scheduled] ${text}` },
        ]

        state.llmRef?.send({
          type: 'stream', requestId, model, messages: apiMessages, tools,
          role: 'reasoning', clientId,
          replyTo: context.self as unknown as ActorRef<LlmProviderReply>,
        })

        return {
          state: {
            ...state,
            activeClientId,
            history: [...state.history, { role: 'user' as const, content: `[Internal Instruction] ${text}` }],
            requestId,
            turnMessages: apiMessages,
            pending: '',
            pendingReasoning: '',
            pendingUsage: { promptTokens: 0, completionTokens: 0 },
            spanHandles: { requestSpan, llmSpan, toolSpans: {} },
            toolLoopCount: 0,
          },
          become: awaitingLlmHandler,
        }
      }

      let userText = text
      if (images && images.length > 0) {
        const imageNote = images.length === 1
          ? `[Image attached: "${images[0]}"]`
          : `[Images attached: ${images.map(p => `"${p}"`).join(', ')}]`
        userText = text ? `${text}\n\n${imageNote}` : imageNote
      }
      if (audio) {
        const audioNote = `[Audio attached: "${audio}"]`
        userText = userText ? `${userText}\n\n${audioNote}` : audioNote
      }
      if (pdfs && pdfs.length > 0) {
        const pdfNote = pdfs.length === 1
          ? `[PDF attached: "${pdfs[0]}"]`
          : `[PDFs attached: ${pdfs.map(p => `"${p}"`).join(', ')}]`
        userText = userText ? `${userText}\n\n${pdfNote}` : pdfNote
      }

      const apiMessages: ApiMessage[] = [
        ...(fullSystemPrompt ? [{ role: 'system' as const, content: fullSystemPrompt }] : []),
        ...state.history,
        { role: 'user', content: userText },
      ]

      state.llmRef?.send({
        type: 'stream',
        requestId,
        model,
        messages: apiMessages,
        tools,
        role: 'reasoning',
        clientId,
        replyTo: context.self as unknown as ActorRef<LlmProviderReply>,
      })

      return {
        state: {
          ...state,
          activeClientId,
          history: [...state.history, { role: 'user', content: userText }],
          requestId,
          turnMessages: apiMessages,
          pending: '',
          pendingReasoning: '',
          pendingUsage: { promptTokens: 0, completionTokens: 0 },
          spanHandles: { requestSpan, llmSpan, toolSpans: {} },
          toolLoopCount: 0,
        },
        become: awaitingLlmHandler,
      }
    },

    _toolRegistered:     (state, msg): Result => toolRegistered(state, msg),
    _toolUnregistered:   (state, msg): Result => toolUnregistered(state, msg),
    _llmProviderUpdated: (state, msg): Result => llmProviderUpdated(state, msg),
    _userContext:        (state, msg): Result => ({ state: { ...state, userContext: msg.summary } }),
    _plannerDone:        (state, _msg, context): Result => {
      if (state.activePlannerRef) context.stop(state.activePlannerRef)
      return { state: { ...state, activePlannerRef: null } }
    },
  })

  // ─── Handler: awaitingLlm — LLM running, will return tool calls or text ───

  awaitingLlmHandler = onMessage<ChatbotMsg, ChatbotState>({
    llmToolCalls: (state, message, context): Result => {
      const { requestId, calls, usage } = message
      if (requestId !== state.requestId) return { state }

      const handles = state.spanHandles
      handles?.llmSpan?.done({ toolCalls: calls.map(c => c.name) })

      const mergedPending: TokenUsage = usage
        ? { promptTokens: state.pendingUsage.promptTokens + usage.promptTokens, completionTokens: state.pendingUsage.completionTokens + usage.completionTokens }
        : state.pendingUsage

      // Intercept plan tool call — spawn a per-session planner instead of going through the tool loop
      const planCall = plannerConfig ? calls.find(c => c.name === 'plan') : undefined
      if (planCall) {
        let goal: string
        try { goal = (JSON.parse(planCall.arguments) as { goal?: string }).goal ?? planCall.arguments }
        catch { goal = planCall.arguments }

        const plannerRef = context.spawn(
          `planner-${clientId}-${crypto.randomUUID().slice(0, 8)}`,
          createPlannerAgentActor({
            llmRef:       state.llmRef!,
            userContext:  state.userContext,
            tools:        filterTools(state.tools, plannerConfig!.toolFilter),
            model:        plannerConfig!.model        ?? model,
            plansDir:     plannerConfig!.plansDir     ?? 'workspace/plans',
            maxToolLoops: plannerConfig!.maxToolLoops ?? 10,
            clientId:     state.activeClientId,
            goal,
          }),
          createInitialPlannerAgentState(),
        ) as ActorRef<PlannerInputMsg>

        const handoffText = 'Starting a planning session for you.'
        const toolCallHistoryMsgs: ConversationMessage[] = [
          { role: 'assistant', content: null, tool_calls: [{ id: planCall.id, type: 'function', function: { name: 'plan', arguments: planCall.arguments } }] },
          { role: 'tool', content: 'Planning session started.', tool_call_id: planCall.id },
          { role: 'assistant', content: handoffText },
        ]
        handles?.requestSpan.done()
        return {
          state: {
            ...state,
            activePlannerRef: plannerRef,
            history:          [...state.history, ...toolCallHistoryMsgs],
            requestId:        null,
            turnMessages:     null,
            spanHandles:      null,
            pendingBatch:     null,
            pending:          '',
            pendingReasoning: '',
            pendingUsage:     { promptTokens: 0, completionTokens: 0 },
            toolLoopCount:    0,
          },
          events: [
            emit(WsSendTopic, { clientId: state.activeClientId, text: JSON.stringify({ type: 'plannerMode', active: true }) }),
            emit(WsSendTopic, { clientId: state.activeClientId, text: JSON.stringify({ type: 'chunk', text: handoffText }) }),
            emit(WsSendTopic, { clientId: state.activeClientId, text: JSON.stringify({ type: 'done' }) }),
          ],
          become: idleHandler,
        }
      }

      const unknownCall = calls.find(c => !state.tools[c.name])
      if (unknownCall) {
        handles?.requestSpan.error('tool unavailable')
        return {
          state: { ...state, requestId: null, turnMessages: null, spanHandles: null, pendingUsage: { promptTokens: 0, completionTokens: 0 } },
          events: [emit(WsSendTopic, { clientId: state.activeClientId, text: JSON.stringify({ type: 'error', text: 'Tool unavailable. Please try again.' }) })],
          become: idleHandler,
        }
      }

      const assistantToolCalls: ToolCall[] = calls.map(c => ({
        id: c.id,
        type: 'function',
        function: { name: c.name, arguments: c.arguments },
      }))

      const batch: PendingBatch = {
        remaining: calls.length,
        results: [],
        messagesAtCall: state.turnMessages!,
        assistantToolCalls,
      }

      const newToolSpans: Record<string, SpanHandle> = {}
      for (const call of calls) {
        const entry = state.tools[call.name]!
        const toolSpan = handles
          ? context.trace.child(handles.requestSpan.traceId, handles.requestSpan.spanId, 'tool-invoke', { toolName: call.name })
          : null
        if (toolSpan) newToolSpans[call.id] = toolSpan

        context.pipeToSelf(
          ask<ToolInvokeMsg, ToolReply>(
            entry.ref,
            (replyTo) => ({ type: 'invoke', toolName: call.name, arguments: call.arguments, replyTo, clientId, userId: userId ?? undefined }),
            undefined,
            toolSpan ? context.trace.injectHeaders(toolSpan) : undefined,
          ),
          (reply) => ({ type: '_toolResult' as const, toolName: call.name, toolCallId: call.id, reply }),
          (error) => ({
            type: '_toolResult' as const,
            toolName: call.name,
            toolCallId: call.id,
            reply: { type: 'toolError' as const, error: String(error) },
          }),
        )
      }

      return {
        state: {
          ...state,
          requestId: null,
          pendingUsage: mergedPending,
          pendingBatch: batch,
          ...(handles ? { spanHandles: { ...handles, llmSpan: undefined, toolSpans: newToolSpans } } : {}),
        },
        events: [emit(WsSendTopic, { clientId: state.activeClientId, text: JSON.stringify({ type: 'searching', tools: calls.map(c => c.name) }) })],
        become: toolLoopHandler,
      }
    },

    llmChunk: (state, message): Result => {
      if (message.requestId !== state.requestId) return { state }
      const { text } = message
      return {
        state: { ...state, pending: state.pending + text },
        events: [emit(WsSendTopic, { clientId: state.activeClientId, text: JSON.stringify({ type: 'chunk', text }) })],
      }
    },

    llmReasoningChunk: (state, message): Result => {
      if (message.requestId !== state.requestId) return { state }
      const { text } = message
      return {
        state: { ...state, pendingReasoning: state.pendingReasoning + text },
        events: [emit(WsSendTopic, { clientId: state.activeClientId, text: JSON.stringify({ type: 'reasoningChunk', text }) })],
      }
    },

    llmDone: (state, message): Result => {
      const { requestId, usage } = message
      if (requestId !== state.requestId) return { state }

      const handles = state.spanHandles
      handles?.llmSpan?.done()
      handles?.requestSpan.done()

      const accumulated = state.pendingUsage
      const totalUsage: TokenUsage | null = usage
        ? { promptTokens: accumulated.promptTokens + usage.promptTokens, completionTokens: accumulated.completionTokens + usage.completionTokens }
        : (accumulated.promptTokens > 0 ? accumulated : null)

      const prevSession = state.sessionUsage
      const newSession: TokenUsage = totalUsage
        ? { promptTokens: prevSession.promptTokens + totalUsage.promptTokens, completionTokens: prevSession.completionTokens + totalUsage.completionTokens }
        : prevSession

      const rawHistory: ConversationMessage[] = [...state.history, { role: 'assistant', content: state.pending }]
      const newHistory = historyWindow ? trimHistory(rawHistory, historyWindow) : rawHistory

      const userMsg = state.turnMessages?.findLast(m => m.role === 'user')
      const userText = typeof userMsg?.content === 'string' ? userMsg.content : ''

      return {
        state: {
          ...state,
          history: newHistory,
          pending: '',
          pendingReasoning: '',
          requestId: null,
          turnMessages: null,
          spanHandles: null,
          pendingUsage: { promptTokens: 0, completionTokens: 0 },
          sessionUsage: newSession,
        },
        events: [
          emit(MemoryStreamTopic, { userId: userId ?? 'default', userText, assistantText: state.pending, timestamp: Date.now() }),
          emit(WsSendTopic, { clientId: state.activeClientId, text: JSON.stringify({ type: 'done' }) }),
        ],
        become: idleHandler,
      }
    },

    llmError: (state, message, context): Result => {
      const { requestId, error } = message
      if (requestId !== state.requestId) return { state }

      context.log.error('LLM stream failed', { clientId, error: String(error) })
      state.spanHandles?.llmSpan?.error(error)
      state.spanHandles?.requestSpan?.error(error)

      return {
        state: { ...state, requestId: null, turnMessages: null, spanHandles: null, pending: '', pendingReasoning: '', pendingUsage: { promptTokens: 0, completionTokens: 0 } },
        events: [emit(WsSendTopic, { clientId: state.activeClientId, text: JSON.stringify({ type: 'error', text: 'Something went wrong. Please try again.' }) })],
        become: idleHandler,
      }
    },

    _toolRegistered:     (state, msg): Result => toolRegistered(state, msg),
    _toolUnregistered:   (state, msg): Result => toolUnregistered(state, msg),
    _llmProviderUpdated: (state, msg): Result => llmProviderUpdated(state, msg),
    _userContext:        (state, msg): Result => ({ state: { ...state, userContext: msg.summary } }),
  })

  // ─── Handler: toolLoop — tools executing, accumulating results ───

  toolLoopHandler = onMessage<ChatbotMsg, ChatbotState>({
    _toolResult: (state, message, context): Result => {
      const { toolName, toolCallId, reply } = message
      const batch = state.pendingBatch!
      const handles = state.spanHandles

      const toolSpan = handles?.toolSpans[toolCallId]
      if (toolSpan) {
        reply.type === 'toolResult' ? toolSpan.done() : toolSpan.error(reply.error)
      }

      const content = reply.type === 'toolResult' ? reply.result : `Tool error: ${reply.error}`
      const sources = reply.type === 'toolResult' ? reply.sources : undefined
      const updatedResults = [...batch.results, { toolCallId, toolName, content }]
      const remaining = batch.remaining - 1

      const sourceEvents = sources
        ? [emit(WsSendTopic, { clientId: state.activeClientId, text: JSON.stringify({ type: 'sources', sources }) })]
        : []

      if (remaining > 0) {
        return {
          state: { ...state, pendingBatch: { ...batch, remaining, results: updatedResults } },
          events: sourceEvents,
        }
      }

      // All tools done — check loop limit before looping back
      const nextLoopCount = state.toolLoopCount + 1

      const toolCallHistoryMsgs: Array<ConversationMessage> = [
        { role: 'assistant', content: null, tool_calls: batch.assistantToolCalls },
        ...updatedResults.map(r => ({ role: 'tool' as const, content: r.content, tool_call_id: r.toolCallId })),
      ]

      if (nextLoopCount >= maxToolLoops) {
        context.log.warn('tool loop limit reached', { clientId, limit: maxToolLoops })
        handles?.requestSpan.error('tool loop limit reached')
        return {
          state: {
            ...state,
            history: [...state.history, ...toolCallHistoryMsgs],
            requestId: null,
            turnMessages: null,
            spanHandles: null,
            pendingBatch: null,
            pending: '',
            pendingReasoning: '',
            pendingUsage: { promptTokens: 0, completionTokens: 0 },
            toolLoopCount: 0,
          },
          events: [
            ...sourceEvents,
            emit(WsSendTopic, { clientId: state.activeClientId, text: JSON.stringify({ type: 'error', text: 'Tool loop limit reached. Please try again.' }) }),
          ],
          become: idleHandler,
        }
      }

      // Build next LLM request, loop back to awaitingLlm
      const toolResultMsgs: ApiMessage[] = updatedResults.map(r => ({
        role: 'tool', content: r.content, tool_call_id: r.toolCallId,
      }))
      const messagesWithResults: ApiMessage[] = [
        ...batch.messagesAtCall,
        { role: 'assistant', content: null, tool_calls: batch.assistantToolCalls },
        ...toolResultMsgs,
      ]

      const llmSpan = handles
        ? context.trace.child(handles.requestSpan.traceId, handles.requestSpan.spanId, 'llm-response', { model })
        : null

      const requestId = crypto.randomUUID()
      const toolSchemas = [
        ...Object.values(state.tools).map((e: ToolEntry) => e.schema as Tool),
        ...(plannerConfig ? [PLAN_TOOL_SCHEMA] : []),
      ]
      const tools = toolSchemas.length > 0 ? toolSchemas : undefined

      state.llmRef?.send({
        type: 'stream',
        requestId,
        model,
        messages: messagesWithResults,
        tools,
        role: 'reasoning',
        clientId,
        replyTo: context.self as unknown as ActorRef<LlmProviderReply>,
      })

      return {
        state: {
          ...state,
          requestId,
          turnMessages: messagesWithResults,
          history: [...state.history, ...toolCallHistoryMsgs],
          pendingBatch: null,
          pending: '',
          toolLoopCount: nextLoopCount,
          ...(handles ? { spanHandles: { ...handles, llmSpan: llmSpan ?? undefined, toolSpans: {} } } : {}),
        },
        events: sourceEvents,
        become: awaitingLlmHandler,
      }
    },

    _toolRegistered:     (state, msg): Result => toolRegistered(state, msg),
    _toolUnregistered:   (state, msg): Result => toolUnregistered(state, msg),
    _llmProviderUpdated: (state, msg): Result => llmProviderUpdated(state, msg),
    _userContext:        (state, msg): Result => ({ state: { ...state, userContext: msg.summary } }),
  })

  return {
    persistence: userId ? createPersistence(userId, clientId, initialLlmRef) : undefined,

    lifecycle: onLifecycle({
      start: (state, context) => {
        context.subscribe(ToolRegistrationTopic, (event) => {
          if (!applyToolFilter(event.name, toolFilter)) return null
          if ('schema' in event) {
            return { type: '_toolRegistered' as const, name: event.name, schema: event.schema, ref: event.ref }
          }
          return { type: '_toolUnregistered' as const, name: event.name }
        })

        context.subscribe(LlmProviderTopic, (event) =>
          ({ type: '_llmProviderUpdated' as const, ref: event.ref }),
        )

        context.subscribe(UserContextTopic, (event) =>
          ({ type: '_userContext' as const, summary: event.summary }),
        )

        return { state }
      },
    }),

    handler: idleHandler,

    supervision: { type: 'restart', maxRetries: 3, withinMs: 30_000 },
  }
}
