import type { ActorDef, ActorRef, MessageHandler } from '../../system/types.ts'
import { onLifecycle, onMessage } from '../../system/match.ts'
import { emit } from '../../system/types.ts'
import type { ToolCollection, ToolEntry, ToolInvokeMsg, ToolReply } from '../../types/tools.ts'
import { ask } from '../../system/ask.ts'
import type {
  ApiMessage,
  LlmProviderMsg,
  LlmProviderReply,
  ModelInfo,
  Tool,
  ToolCall,
} from '../../types/llm.ts'
import { WsBroadcastTopic } from '../../types/ws.ts'
import type { UserContextMsg } from '../../types/memory.ts'
import { UserContextTopic } from '../../types/memory.ts'

// ─── Options ───

export type UserContextOptions = {
  model:         string
  userId:        string
  llmRef:        ActorRef<LlmProviderMsg>
  tools:         ToolCollection
  maxToolLoops?: number
}

// ─── Internal types ───

type PendingBatch = {
  remaining:          number
  results:            Array<{ toolCallId: string; toolName: string; content: string }>
  messagesAtCall:     ApiMessage[]
  assistantToolCalls: ToolCall[]
}

export type UserContextState = {
  pendingRun:    boolean
  requestId:     string | null
  messages:      ApiMessage[] | null
  accumulated:   string
  pendingBatch:  PendingBatch | null
  modelInfo:     ModelInfo | null
  toolLoopCount: number
}

// ─── System prompt ───

const buildSystemPrompt = (userId: string): string =>
  `You are a user model agent for user "${userId}". Your task is to read the user's accumulated memory and produce a comprehensive user context summary.\n\n` +
  `This summary will be injected into a chatbot's system prompt before every response. Its purpose is to give the chatbot a complete, up-to-date picture of who this user is, so that every answer, suggestion, and action is adapted to them specifically.\n\n` +
  `Read the following to build a complete picture:\n` +
  `- Procedural memory files at /workspace/memory/${userId}/procedural/ — skills, preferences, workflows, tools\n` +
  `- Episodic memory files at /workspace/memory/${userId}/episodic/ — notable events and decisions (skim for recurring themes)\n` +
  `- The knowledge graph via kgraph_query — entities, facts, and relationships\n` +
  `- The existing context summary at /workspace/memory/${userId}/context.md if it exists — use it as a starting point\n\n` +
  `The summary should cover:\n` +
  `- Who the user is: role, profession, background, domain expertise\n` +
  `- Current projects and goals: what they are actively working on and why\n` +
  `- Preferences and working style: tools, languages, frameworks, workflows they prefer or avoid\n` +
  `- Interests and areas of curiosity beyond their main work\n` +
  `- Key attributes and personality: how they communicate, what they value, how they like to collaborate\n` +
  `- Any important context that changes how an AI assistant should respond to them\n\n` +
  `Write 2–4 dense, well-organized paragraphs. Be specific and concrete — prefer "uses TypeScript and Bun, prefers functional patterns" over "is a developer". Do not include raw conversation excerpts. Write in third person, present tense. Your final text response (with no trailing tool calls) is the summary.`

const buildInitialMessages = (userId: string): ApiMessage[] => [
  { role: 'system', content: buildSystemPrompt(userId) },
  { role: 'user', content: 'Read the memory files and produce the updated user context summary.' },
]

// ─── Actor definition ───

export const createUserContextActor = (options: UserContextOptions): ActorDef<UserContextMsg, UserContextState> => {
  const { model, userId, llmRef, tools, maxToolLoops = 25 } = options

  let awaitingLlmHandler: MessageHandler<UserContextMsg, UserContextState>
  let toolLoopHandler:    MessageHandler<UserContextMsg, UserContextState>

  // ─── Start a summary run ───

  const startSummary = (
    state: UserContextState,
    context: Parameters<MessageHandler<UserContextMsg, UserContextState>>[2],
  ): ReturnType<MessageHandler<UserContextMsg, UserContextState>> => {
    const messages = buildInitialMessages(userId)
    const toolSchemas = Object.values(tools).map((e: ToolEntry) => e.schema as Tool)
    const requestId = crypto.randomUUID()

    llmRef.send({
      type: 'stream',
      requestId,
      model,
      messages,
      tools: toolSchemas.length > 0 ? toolSchemas : undefined,
      replyTo: context.self as unknown as ActorRef<LlmProviderReply>,
    })

    context.log.info('user context summary started', { userId })

    return {
      state: { ...state, pendingRun: false, requestId, messages, accumulated: '', pendingBatch: null, toolLoopCount: 0 },
      become: awaitingLlmHandler,
    }
  }

  // ─── Handler: idle ───

  const idleHandler: MessageHandler<UserContextMsg, UserContextState> = onMessage<UserContextMsg, UserContextState>({
    _run: (state, _, context) => startSummary(state, context),

    _contextSaved:      (state, msg, context) => { context.log.info('user context file saved', { userId: msg.userId }); return { state } },
    _contextSaveFailed: (state, msg, context) => { context.log.error('user context file save failed', { userId: msg.userId, error: msg.error }); return { state } },
  })

  // ─── Handler: awaitingLlm ───

  awaitingLlmHandler = onMessage<UserContextMsg, UserContextState>({
    _run: (state) => ({ state: { ...state, pendingRun: true } }),

    llmChunk: (state, msg) => {
      if (msg.requestId !== state.requestId) return { state }
      return { state: { ...state, accumulated: state.accumulated + msg.text } }
    },

    llmReasoningChunk: (state) => ({ state }),

    llmToolCalls: (state, msg, context) => {
      if (msg.requestId !== state.requestId) return { state }

      const { calls } = msg

      const assistantToolCalls: ToolCall[] = calls.map(c => ({
        id: c.id,
        type: 'function',
        function: { name: c.name, arguments: c.arguments },
      }))

      const batch: PendingBatch = {
        remaining: calls.length,
        results: [],
        messagesAtCall: state.messages!,
        assistantToolCalls,
      }

      for (const call of calls) {
        const entry = tools[call.name]
        if (!entry) {
          context.log.warn('user context: unknown tool', { tool: call.name })
          continue
        }
        context.pipeToSelf(
          ask<ToolInvokeMsg, ToolReply>(
            entry.ref,
            (replyTo) => ({ type: 'invoke', toolName: call.name, arguments: call.arguments, replyTo }),
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
        state: { ...state, requestId: null, pendingBatch: batch },
        become: toolLoopHandler,
      }
    },

    llmDone: (state, msg, context) => {
      if (msg.requestId !== state.requestId) return { state }

      const summary = state.accumulated
      context.log.info('user context summary generated', { userId, length: summary.length })

      context.publishRetained(UserContextTopic, userId, { userId, summary })

      context.pipeToSelf(
        Bun.write(`workspace/memory/${userId}/context.md`, summary),
        () => ({ type: '_contextSaved' as const, userId }),
        (error) => ({ type: '_contextSaveFailed' as const, userId, error: String(error) }),
      )

      const usageEvents = msg.usage
        ? [emit(WsBroadcastTopic, { text: JSON.stringify({
            type: 'usage',
            role: 'user-context',
            model,
            inputTokens:   msg.usage.promptTokens,
            outputTokens:  msg.usage.completionTokens,
            contextWindow: state.modelInfo?.contextWindow ?? null,
            cost: state.modelInfo
              ? (msg.usage.promptTokens     / 1_000_000 * state.modelInfo.promptPer1M)
              + (msg.usage.completionTokens / 1_000_000 * state.modelInfo.completionPer1M)
              : null,
          }) })]
        : []

      const next = { ...state, requestId: null, messages: null, accumulated: '', pendingBatch: null }
      if (state.pendingRun) {
        const { state: nextState } = startSummary(next, context)
        return { state: nextState, become: awaitingLlmHandler, events: usageEvents }
      }
      return { state: next, become: idleHandler, events: usageEvents }
    },

    llmError: (state, msg, context) => {
      if (msg.requestId !== state.requestId) return { state }
      context.log.error('user context summary LLM error', { userId, error: String(msg.error) })
      const next = { ...state, requestId: null, messages: null, accumulated: '', pendingBatch: null }
      if (state.pendingRun) return startSummary(next, context)
      return { state: next, become: idleHandler }
    },

    _contextSaved:      (state, msg, context) => { context.log.info('user context file saved', { userId: msg.userId }); return { state } },
    _contextSaveFailed: (state, msg, context) => { context.log.error('user context file save failed', { userId: msg.userId, error: msg.error }); return { state } },
  })

  // ─── Handler: toolLoop ───

  toolLoopHandler = onMessage<UserContextMsg, UserContextState>({
    _run: (state) => ({ state: { ...state, pendingRun: true } }),

    _toolResult: (state, msg, context) => {
      const batch = state.pendingBatch!
      const content = msg.reply.type === 'toolResult' ? msg.reply.result : `Tool error: ${msg.reply.error}`
      const updatedResults = [...batch.results, { toolCallId: msg.toolCallId, toolName: msg.toolName, content }]
      const remaining = batch.remaining - 1

      if (remaining > 0) {
        return { state: { ...state, pendingBatch: { ...batch, remaining, results: updatedResults } } }
      }

      // All tools done — check loop limit before looping back
      const nextLoopCount = state.toolLoopCount + 1

      if (nextLoopCount >= maxToolLoops) {
        context.log.warn('user context tool loop limit reached', { userId, limit: maxToolLoops })
        const next = { ...state, requestId: null, messages: null, accumulated: '', pendingBatch: null, toolLoopCount: 0 }
        if (state.pendingRun) return startSummary(next, context)
        return { state: next, become: idleHandler }
      }

      // Build next LLM request
      const toolResultMsgs: ApiMessage[] = updatedResults.map(r => ({
        role: 'tool', content: r.content, tool_call_id: r.toolCallId,
      }))
      const nextMessages: ApiMessage[] = [
        ...batch.messagesAtCall,
        { role: 'assistant', content: null, tool_calls: batch.assistantToolCalls },
        ...toolResultMsgs,
      ]

      const requestId = crypto.randomUUID()
      const toolSchemas = Object.values(tools).map((e: ToolEntry) => e.schema as Tool)

      llmRef.send({
        type: 'stream',
        requestId,
        model,
        messages: nextMessages,
        tools: toolSchemas.length > 0 ? toolSchemas : undefined,
        replyTo: context.self as unknown as ActorRef<LlmProviderReply>,
      })

      return {
        state: { ...state, requestId, messages: nextMessages, pendingBatch: null, toolLoopCount: nextLoopCount },
        become: awaitingLlmHandler,
      }
    },

    _contextSaved:      (state, msg, context) => { context.log.info('user context file saved', { userId: msg.userId }); return { state } },
    _contextSaveFailed: (state, msg, context) => { context.log.error('user context file save failed', { userId: msg.userId, error: msg.error }); return { state } },
  })

  return {
    handler: idleHandler,

    lifecycle: onLifecycle({
      start: async (state, _context) => {
        const modelInfo = await ask<LlmProviderMsg, ModelInfo | null>(
          llmRef,
          (replyTo) => ({ type: 'fetchModelInfo', model, replyTo }),
        ).catch(() => null)
        return { state: { ...state, modelInfo } }
      },
    }),
  }
}

export const INITIAL_USER_CONTEXT_STATE: UserContextState = {
  pendingRun:    false,
  requestId:     null,
  messages:      null,
  accumulated:   '',
  pendingBatch:  null,
  modelInfo:     null,
  toolLoopCount: 0,
}
