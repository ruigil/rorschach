import type { ActorDef, ActorRef, MessageHandler, ActorResult } from '../../system/types.ts'
import { onMessage } from '../../system/match.ts'
import type { ToolCollection, ToolEntry, ToolInvokeMsg, ToolReply } from '../../types/tools.ts'
import { ask } from '../../system/ask.ts'
import type {
  ApiMessage,
  LlmProviderMsg,
  LlmProviderReply,
  Tool,
  ToolCall,
} from '../../types/llm.ts'
import type { UserContextMsg } from './types.ts'
import { UserContextTopic } from '../../types/memory.ts'
import { zettelStoreSection } from './ontology.ts'
import { CronTriggerTopic } from '../../types/events.ts'

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
  requestId:     string | null
  messages:      ApiMessage[] | null
  accumulated:   string
  summary:       string | null
  pendingBatch:  PendingBatch | null
  toolLoopCount: number
}

// ─── System prompt ───

const buildSystemPrompt = (userId: string): string =>
  `You are a user model agent for user "${userId}". Your task is to produce an updated user context summary.\n\n` +
  `This summary will be injected into a chatbot's system prompt before every response. Its purpose is to give the chatbot a complete, up-to-date picture of who this user is.\n\n` +
  zettelStoreSection(userId) + '\n\n' +
  `## Workflow\n\n` +
  `1. Read the existing summary at /workspace/memory/${userId}/context.md (if it exists) — this is your starting point.\n` +
  `2. List all notes to get the full inventory:\n` +
  `   zettel_list { userId: "${userId}" }\n` +
  `3. For notes not yet reflected in the existing summary, read them:\n` +
  `   zettel_read { id: "<id>", userId: "${userId}" }\n` +
  `4. Produce an updated summary incorporating all note content.\n\n` +
  `Only read notes whose synopsis suggests content not yet captured in the existing summary. Do not read notes speculatively.\n\n` +
  `## Output\n\n` +
  `Write the most concise description of the user possible — maximum 10 paragraphs, use fewer if the model is small. Each paragraph covers one dimension: identity, current work, projects, goals, preferences, beliefs, relationships, etc. Only include a paragraph if there is meaningful content.\n\n` +
  `Be specific and concrete — prefer "builds actor systems in TypeScript with Bun" over "is a developer". Do not pad or speculate. Write in third person, present tense.\n\n` +
  `Your response MUST be the summary and nothing else — no preamble, no "here is the summary", no reasoning, no commentary before or after. Start directly with the first sentence about the user.`

const buildInitialMessages = (userId: string): ApiMessage[] => [
  { role: 'system', content: buildSystemPrompt(userId) },
  { role: 'user', content: 'Read the memory files and produce the updated user context summary.' },
]

const buildGapPrompt = (userId: string, summary: string): string =>
  `You are a user model analyzer for user "${userId}".\n\n` +
  `Review the following user context summary:\n\n` +
  `---\n${summary}\n---\n\n` +
  `Identify the single most critical information gap that, if filled, would most improve this user model (e.g., a missing goal, an ambiguous preference, or a vague professional background).\n\n` +
  `Formulate one direct, polite, and concise question to ask the user to fill this gap.\n\n` +
  `Rules:\n` +
  `1. Output the question as an instruction for the chatbot, starting with "Ask the user: ".\n` +
  `2. No preamble, no "Based on the summary...", no reasoning.\n` +
  `3. If the model is already very complete and there are no critical gaps, respond with an empty message.\n` +
  `4. Example: "Ask the user: What are your primary goals ?"`

// ─── Actor definition ───

export const createUserContextActor = (options: UserContextOptions): ActorDef<UserContextMsg, UserContextState> => {
  const { model, userId, llmRef, tools, maxToolLoops = 25 } = options

  type Result = ActorResult<UserContextMsg, UserContextState>

  let awaitingLlmHandler:         MessageHandler<UserContextMsg, UserContextState>
  let toolLoopHandler:            MessageHandler<UserContextMsg, UserContextState>
  let awaitingGapQuestionHandler: MessageHandler<UserContextMsg, UserContextState>

  // ─── Start a summary run ───

  const startSummary = (
    state: UserContextState,
    context: Parameters<MessageHandler<UserContextMsg, UserContextState>>[2],
  ): Result => {
    const messages = buildInitialMessages(userId)
    const toolSchemas = Object.values(tools).map((e: ToolEntry) => e.schema as Tool)
    const requestId = crypto.randomUUID()

    llmRef.send({
      type: 'stream',
      requestId,
      model,
      messages,
      tools: toolSchemas.length > 0 ? toolSchemas : undefined,
      role: 'user-context',
      replyTo: context.self as unknown as ActorRef<LlmProviderReply>,
    })

    context.log.info('user context summary started', { userId })

    return {
      state: { ...state, requestId, messages, accumulated: '', summary: null, pendingBatch: null, toolLoopCount: 0 },
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
    llmChunk: (state, msg): Result => {
      if (msg.requestId !== state.requestId) return { state }
      return { state: { ...state, accumulated: state.accumulated + msg.text } }
    },

    llmReasoningChunk: (state): Result => ({ state }),

    llmToolCalls: (state, msg, context): Result => {
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
            (replyTo) => ({ type: 'invoke', toolName: call.name, arguments: call.arguments, replyTo, userId }),
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
        state: { ...state, requestId: null, accumulated: '', pendingBatch: batch },
        become: toolLoopHandler,
      }
    },

    llmDone: (state, msg, context): Result => {
      if (msg.requestId !== state.requestId) return { state }

      const summary = state.accumulated
      context.log.info('user context summary generated', { userId, length: summary.length })

      context.publishRetained(UserContextTopic, userId, { userId, summary })

      context.pipeToSelf(
        Bun.write(`workspace/memory/${userId}/context.md`, summary),
        () => ({ type: '_contextSaved' as const, userId }),
        (error) => ({ type: '_contextSaveFailed' as const, userId, error: String(error) }),
      )

      // ─── Trigger Pass 2: Gap analysis ───
      const requestId = crypto.randomUUID()
      llmRef.send({
        type: 'stream',
        requestId,
        model,
        messages: [{ role: 'system', content: buildGapPrompt(userId, summary) }],
        role: 'user-context',
        replyTo: context.self as unknown as ActorRef<LlmProviderReply>,
      })

      return {
        state: { ...state, requestId, messages: null, accumulated: '', summary, pendingBatch: null },
        become: awaitingGapQuestionHandler,
      }
    },

    llmError: (state, msg, context): Result => {
      if (msg.requestId !== state.requestId) return { state }
      context.log.error('user context summary LLM error', { userId, error: String(msg.error) })
      return { state: { ...state, requestId: null, messages: null, accumulated: '', pendingBatch: null }, become: idleHandler }
    },

    _contextSaved:      (state, msg, context): Result => { context.log.info('user context file saved', { userId: msg.userId }); return { state } },
    _contextSaveFailed: (state, msg, context): Result => { context.log.error('user context file save failed', { userId: msg.userId, error: msg.error }); return { state } },

  })

  // ─── Handler: toolLoop ───

  toolLoopHandler = onMessage<UserContextMsg, UserContextState>({
    _toolResult: (state, msg, context): Result => {
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
        return { state: { ...state, requestId: null, messages: null, accumulated: '', pendingBatch: null, toolLoopCount: 0 }, become: idleHandler }
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
        role: 'user-context',
        replyTo: context.self as unknown as ActorRef<LlmProviderReply>,
      })

      return {
        state: { ...state, requestId, messages: nextMessages, accumulated: '', pendingBatch: null, toolLoopCount: nextLoopCount },
        become: awaitingLlmHandler,
      }
    },

    _contextSaved:      (state, msg, context): Result => { context.log.info('user context file saved', { userId: msg.userId }); return { state } },
    _contextSaveFailed: (state, msg, context): Result => { context.log.error('user context file save failed', { userId: msg.userId, error: msg.error }); return { state } },

  })

  // ─── Handler: awaitingGapQuestion ───

  awaitingGapQuestionHandler = onMessage<UserContextMsg, UserContextState>({
    llmChunk: (state, msg): Result => {
      if (msg.requestId !== state.requestId) return { state }
      return { state: { ...state, accumulated: state.accumulated + msg.text } }
    },

    llmReasoningChunk: (state): Result => ({ state }),

    llmDone: (state, msg, context): Result => {
      if (msg.requestId !== state.requestId) return { state }

      const question = state.accumulated.trim()
      if (question) {
        context.log.info('user context gap identified', { userId, question: question.slice(0, 100) })
        const span = context.trace.start('gap-analysis-trigger', { userId })
        context.publish(CronTriggerTopic, {
          userId,
          text:         question,
          traceId:      span.traceId,
          parentSpanId: span.spanId,
        })
        span.done()
      } else {
        context.log.info('user context model complete, no question needed', { userId })
      }

      return {
        state: { ...state, requestId: null, messages: null, accumulated: '', summary: null },
        become: idleHandler,
      }
    },

    llmError: (state, msg, context): Result => {
      if (msg.requestId !== state.requestId) return { state }
      context.log.error('user context gap analysis LLM error', { userId, error: String(msg.error) })
      return {
        state: { ...state, requestId: null, messages: null, accumulated: '', summary: null },
        become: idleHandler,
      }
    },

    _contextSaved:      (state, msg, context): Result => { context.log.info('user context file saved', { userId: msg.userId }); return { state } },
    _contextSaveFailed: (state, msg, context): Result => { context.log.error('user context file save failed', { userId: msg.userId, error: msg.error }); return { state } },
  })

  return {
    handler: idleHandler,
  }
}

export const INITIAL_USER_CONTEXT_STATE: UserContextState = {
  requestId:     null,
  messages:      null,
  accumulated:   '',
  summary:       null,
  pendingBatch:  null,
  toolLoopCount: 0,
}
