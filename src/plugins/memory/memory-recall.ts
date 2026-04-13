import type { ActorDef, ActorRef, MessageHandler } from '../../system/types.ts'
import { onLifecycle, onMessage } from '../../system/match.ts'
import { ask } from '../../system/ask.ts'
import type { ToolCollection, ToolEntry, ToolInvokeMsg, ToolReply } from '../../types/tools.ts'
import type {
  ApiMessage,
  LlmProviderMsg,
  LlmProviderReply,
  Tool,
  ToolCall,
} from '../../types/llm.ts'
import type { UserMemoryMsg, MemoryRecallMsg } from '../../types/memory.ts'
import { ontologySection } from './ontology.ts'

// ─── Options ───

export type MemoryRecallOptions = {
  recallId:      string
  query:         string
  replyTo:       ActorRef<ToolReply>
  parentRef:     ActorRef<UserMemoryMsg>
  llmRef:        ActorRef<LlmProviderMsg>
  model:         string
  userId:        string
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

type RecallState = {
  requestId:     string | null
  turnMessages:  ApiMessage[] | null
  accumulated:   string
  pendingBatch:  PendingBatch | null
  toolLoopCount: number
}

// ─── System prompt ───

const buildSystemPrompt = (userId: string): string =>
  `You are a memory retrieval agent for user "${userId}". Answer the query by searching the knowledge graph and reading referenced knowledge base files.\n\n` +
  `The knowledge graph is shared across all users. You MUST always anchor queries on the user's root node to avoid returning data belonging to other users.\n\n` +
  ontologySection(userId) + '\n\n' +
  `Strategy:\n` +
  `1. Use kgraph_query anchored on the user root node. Use relationship types and node labels from the schema above to write precise queries.\n` +
  `   Broad scan:    MATCH (u:Entity {name:"${userId}"})-[r]->(m) RETURN type(r), m.name, r.source_file\n` +
  `   Targeted:      MATCH (u:Entity {name:"${userId}"})-[r:KNOWS]->(t:Entity) RETURN t.name, r.source_file\n` +
  `   Multi-hop:     MATCH (u:Entity {name:"${userId}"})-[r*1..2]->(m) RETURN type(r[-1]), m.name, r[-1].source_file\n` +
  `2. Use read to read the source_file paths returned by the graph — these are the knowledge base files at /workspace/memory/${userId}/kbase/.\n` +
  `3. Run follow-up graph queries if needed, always keeping the user root as the starting point.\n` +
  `4. Synthesize a concise answer from what you found.\n\n` +
  `Only read files the graph points to. If nothing relevant is found, say so plainly.`

// ─── Actor definition ───

export const createMemoryRecallActor = (options: MemoryRecallOptions): ActorDef<MemoryRecallMsg, RecallState> => {
  const { recallId, query, replyTo, parentRef, llmRef, model, userId, tools, maxToolLoops = 25 } = options

  let toolLoopHandler: MessageHandler<MemoryRecallMsg, RecallState>

  const toolSchemas = Object.values(tools).map((e: ToolEntry) => e.schema as Tool)

  const finish = (state: RecallState, reply: ToolReply): ReturnType<MessageHandler<MemoryRecallMsg, RecallState>> => {
    replyTo.send(reply)
    parentRef.send({ type: '_recallDone', recallId })
    return { state }
  }

  // ─── Handler: awaitingLlm ───

  const awaitingLlmHandler: MessageHandler<MemoryRecallMsg, RecallState> = onMessage<MemoryRecallMsg, RecallState>({
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
        messagesAtCall: state.turnMessages!,
        assistantToolCalls,
      }

      for (const call of calls) {
        const entry = tools[call.name]
        if (!entry) {
          context.log.warn('memory recall: unknown tool', { tool: call.name })
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

    llmDone: (state, msg) => {
      if (msg.requestId !== state.requestId) return { state }
      return finish(state, { type: 'toolResult', result: state.accumulated || '(no result)' })
    },

    llmError: (state, msg) => {
      if (msg.requestId !== state.requestId) return { state }
      return finish(state, { type: 'toolError', error: String(msg.error) })
    },
  })

  // ─── Handler: toolLoop ───

  toolLoopHandler = onMessage<MemoryRecallMsg, RecallState>({
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
        context.log.warn('memory recall tool loop limit reached', { userId, limit: maxToolLoops })
        return finish(
          { ...state, pendingBatch: null, toolLoopCount: 0 },
          state.accumulated ? { type: 'toolResult', result: state.accumulated } : { type: 'toolError', error: 'Tool loop limit reached' },
        )
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

      llmRef.send({
        type: 'stream',
        requestId,
        model,
        messages: nextMessages,
        tools: toolSchemas.length > 0 ? toolSchemas : undefined,
        role: 'memory-recall',
        replyTo: context.self as unknown as ActorRef<LlmProviderReply>,
      })

      return {
        state: { ...state, requestId, turnMessages: nextMessages, pendingBatch: null, toolLoopCount: nextLoopCount },
        become: awaitingLlmHandler,
      }
    },
  })

  return {
    lifecycle: onLifecycle({
      start: (state, context) => {
        const requestId = crypto.randomUUID()
        const messages: ApiMessage[] = [
          { role: 'system', content: buildSystemPrompt(userId) },
          { role: 'user', content: query },
        ]
        llmRef.send({
          type: 'stream',
          requestId,
          model,
          messages,
          tools: toolSchemas.length > 0 ? toolSchemas : undefined,
          role: 'memory-recall',
          replyTo: context.self as unknown as ActorRef<LlmProviderReply>,
        })
        return { state: { ...state, requestId, turnMessages: messages } }
      },
    }),

    handler: awaitingLlmHandler,
  }
}

export const INITIAL_RECALL_STATE: RecallState = {
  requestId:     null,
  turnMessages:  null,
  accumulated:   '',
  pendingBatch:  null,
  toolLoopCount: 0,
}
