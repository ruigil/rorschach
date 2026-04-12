import type { ActorDef, ActorRef, MessageHandler } from '../../system/types.ts'
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
import type { UserContextMsg } from '../../types/memory.ts'
import { UserContextTopic } from '../../types/memory.ts'
import { ontologySection } from './ontology.ts'

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
  toolLoopCount: number
}

// ─── System prompt ───

const buildSystemPrompt = (userId: string): string =>
  `You are a user model agent for user "${userId}". Your task is to produce an updated user context summary.\n\n` +
  `This summary will be injected into a chatbot's system prompt before every response. Its purpose is to give the chatbot a complete, up-to-date picture of who this user is.\n\n` +
  ontologySection(userId) + '\n\n' +
  `## Workflow\n\n` +
  `1. Read the existing summary at /workspace/memory/${userId}/context.md (if it exists) — this is your starting point.\n` +
  `2. Query the knowledge graph anchored on the user root node to get the full index of known facts:\n` +
  `   MATCH (u:Entity {name:"${userId}"})-[r]->(m) RETURN type(r), m.name, r.source_file, r.since, r.confidence\n` +
  `   Interpret the results:\n` +
  `   - Current-state types (WORKS_ON, HAS_GOAL, PREFERS, LOCATED_IN, VISITING, KNOWS, BELIEVES, OWNS, ATTENDED, PART_OF, HAS_HABIT)\n` +
  `     → include in the active profile; read source_file to get detail\n` +
  `   - Archive types (WORKED_ON, ACHIEVED_GOAL, ABANDONED_GOAL, PREFERRED, LIVED_IN, HAD_HABIT)\n` +
  `     → include only in a brief History section at the end; do NOT read source_file for these\n` +
  `   - confidence:"inferred" → soften the language: "appears to", "tends to", "likely prefers"\n` +
  `3. For any current-state fact whose source_file you have not yet reflected in the existing summary, read that kbase file.\n` +
  `4. Produce an updated summary incorporating the new information.\n\n` +
  `Only read kbase files when the graph points to facts not yet captured in the existing summary. Do not read files speculatively.\n\n` +
  `## Output\n\n` +
  `Write the most concise description of the user possible — maximum 10 paragraphs, use fewer if the model is small. Each paragraph covers one dimension: identity, current work, projects, goals, preferences, beliefs, relationships, etc. Only include a paragraph if there is meaningful content.\n\n` +
  `Be specific and concrete — prefer "builds actor systems in TypeScript with Bun" over "is a developer". Do not pad or speculate. Write in third person, present tense.\n\n` +
  `Your response MUST be the summary and nothing else — no preamble, no "here is the summary", no reasoning, no commentary before or after. Start directly with the first sentence about the user.`

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
      role: 'user-context',
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
        state: { ...state, requestId: null, accumulated: '', pendingBatch: batch },
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

      const next = { ...state, requestId: null, messages: null, accumulated: '', pendingBatch: null }
      if (state.pendingRun) {
        const { state: nextState } = startSummary(next, context)
        return { state: nextState, become: awaitingLlmHandler }
      }
      return { state: next, become: idleHandler }
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
        role: 'user-context',
        replyTo: context.self as unknown as ActorRef<LlmProviderReply>,
      })

      return {
        state: { ...state, requestId, messages: nextMessages, accumulated: '', pendingBatch: null, toolLoopCount: nextLoopCount },
        become: awaitingLlmHandler,
      }
    },

    _contextSaved:      (state, msg, context) => { context.log.info('user context file saved', { userId: msg.userId }); return { state } },
    _contextSaveFailed: (state, msg, context) => { context.log.error('user context file save failed', { userId: msg.userId, error: msg.error }); return { state } },
  })

  return {
    handler: idleHandler,
  }
}

export const INITIAL_USER_CONTEXT_STATE: UserContextState = {
  pendingRun:    false,
  requestId:     null,
  messages:      null,
  accumulated:   '',
  pendingBatch:  null,
  toolLoopCount: 0,
}
