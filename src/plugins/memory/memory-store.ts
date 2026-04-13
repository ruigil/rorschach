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
import type { UserMemoryMsg, MemoryStoreMsg } from '../../types/memory.ts'
import { ontologySection } from './ontology.ts'

// ─── Options ───

export type MemoryStoreOptions = {
  storeId:       string
  content:       string
  topic?:        string
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

type StoreState = {
  requestId:     string | null
  turnMessages:  ApiMessage[] | null
  accumulated:   string
  pendingBatch:  PendingBatch | null
  toolLoopCount: number
}

// ─── System prompt ───

const buildSystemPrompt = (userId: string, topic?: string): string => {
  const topicHint = topic ? `\nThe user suggests storing this under the topic: "${topic}".` : ''

  return (
    `You are a memory storage agent for user "${userId}". Store the given information into the knowledge base and knowledge graph.${topicHint}\n\n` +

    `## Knowledge Base  /workspace/memory/${userId}/kbase/{topic}.md\n` +
    `One file per topic. Suggested topics (create as needed):\n` +
    `- identity.md — name, location, background, profession, life stage\n` +
    `- preferences.md — tools, languages, workflows, communication style\n` +
    `- projects.md — active and past projects, their status and goals\n` +
    `- goals.md — short and long-term goals, aspirations, dreams\n` +
    `- beliefs.md — values, principles, opinions\n` +
    `- relationships.md — people the user mentions and their relevance\n` +
    `- communication.md — how the user communicates\n\n` +
    `Read the file before writing to avoid duplication. If the fact already exists, update it in-place.\n\n` +
    `Mutable-fact files (projects.md, goals.md, preferences.md) use two sections:\n` +
    `  ## Active\n` +
    `  ## Past / Achieved / Abandoned\n` +
    `Immutable files (identity.md, beliefs.md, relationships.md) have no past section.\n\n` +

    ontologySection(userId) + '\n\n' +

    `## Write Order\n` +
    `1. bash mkdir -p /workspace/memory/${userId}/kbase if it does not exist\n` +
    `2. Determine the appropriate kbase topic file for the content\n` +
    `3. Read the file first to check for existing entries and avoid duplication\n` +
    `4. Write the updated kbase file\n` +
    `5. Ensure the root anchor exists: kgraph_upsert { label:"Entity", name:"${userId}" }\n` +
    `   Always use the exact string "${userId}" — never a generic label like "User".\n` +
    `   Capture canonicalName from each upsert response — use it (not the name you passed) in all kgraph_write statements.\n` +
    `6. Write new relationships via kgraph_write using the canonicalName values from step 5\n` +
    `7. Return a brief confirmation of what was stored and where\n\n` +
    `Only store what was explicitly provided. Do not infer beyond the given content.`
  )
}

// ─── Actor definition ───

export const createMemoryStoreActor = (options: MemoryStoreOptions): ActorDef<MemoryStoreMsg, StoreState> => {
  const { storeId, content, topic, replyTo, parentRef, llmRef, model, userId, tools, maxToolLoops = 25 } = options

  let toolLoopHandler: MessageHandler<MemoryStoreMsg, StoreState>

  const toolSchemas = Object.values(tools).map((e: ToolEntry) => e.schema as Tool)

  const finish = (state: StoreState, reply: ToolReply): ReturnType<MessageHandler<MemoryStoreMsg, StoreState>> => {
    replyTo.send(reply)
    parentRef.send({ type: '_storeDone', storeId })
    return { state }
  }

  // ─── Handler: awaitingLlm ───

  const awaitingLlmHandler: MessageHandler<MemoryStoreMsg, StoreState> = onMessage<MemoryStoreMsg, StoreState>({
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
          context.log.warn('memory store: unknown tool', { tool: call.name })
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
      return finish(state, { type: 'toolResult', result: state.accumulated || 'Memory stored.' })
    },

    llmError: (state, msg) => {
      if (msg.requestId !== state.requestId) return { state }
      return finish(state, { type: 'toolError', error: String(msg.error) })
    },
  })

  // ─── Handler: toolLoop ───

  toolLoopHandler = onMessage<MemoryStoreMsg, StoreState>({
    _toolResult: (state, msg, context) => {
      const batch = state.pendingBatch!
      const resultContent = msg.reply.type === 'toolResult' ? msg.reply.result : `Tool error: ${msg.reply.error}`
      const updatedResults = [...batch.results, { toolCallId: msg.toolCallId, toolName: msg.toolName, content: resultContent }]
      const remaining = batch.remaining - 1

      if (remaining > 0) {
        return { state: { ...state, pendingBatch: { ...batch, remaining, results: updatedResults } } }
      }

      const nextLoopCount = state.toolLoopCount + 1

      if (nextLoopCount >= maxToolLoops) {
        context.log.warn('memory store tool loop limit reached', { userId, limit: maxToolLoops })
        return finish(
          { ...state, pendingBatch: null, toolLoopCount: 0 },
          state.accumulated ? { type: 'toolResult', result: state.accumulated } : { type: 'toolError', error: 'Tool loop limit reached' },
        )
      }

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
        role: 'memory-store',
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
          { role: 'system', content: buildSystemPrompt(userId, topic) },
          { role: 'user', content },
        ]
        llmRef.send({
          type: 'stream',
          requestId,
          model,
          messages,
          tools: toolSchemas.length > 0 ? toolSchemas : undefined,
          role: 'memory-store',
          replyTo: context.self as unknown as ActorRef<LlmProviderReply>,
        })
        return { state: { ...state, requestId, turnMessages: messages } }
      },
    }),

    handler: awaitingLlmHandler,
  }
}

export const INITIAL_STORE_STATE: StoreState = {
  requestId:     null,
  turnMessages:  null,
  accumulated:   '',
  pendingBatch:  null,
  toolLoopCount: 0,
}
