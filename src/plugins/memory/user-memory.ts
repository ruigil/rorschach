import type { ActorDef, ActorRef } from '../../system/types.ts'
import { onLifecycle, onMessage } from '../../system/match.ts'
import type { ToolCollection, ToolEntry, ToolFilter, ToolInvokeMsg, ToolReply, ToolSchema } from '../../types/tools.ts'
import { applyToolFilter, ToolRegistrationTopic } from '../../types/tools.ts'
import type { LlmProviderMsg } from '../../types/llm.ts'
import { LlmProviderTopic } from '../../types/llm.ts'
import { createMemoryRecallActor, INITIAL_RECALL_STATE } from './memory-recall.ts'
import { createMemoryStoreActor, INITIAL_STORE_STATE } from './memory-store.ts'
import type { MemoryRecallMsg, MemoryStoreMsg } from '../../types/memory.ts'
import type { UserMemoryMsg } from '../../types/memory.ts'

// ─── Tool schemas ───

export const RECALL_MEMORY_TOOL_NAME = 'recall_memory'

export const RECALL_MEMORY_SCHEMA: ToolSchema = {
  type: 'function',
  function: {
    name: 'recall_memory',
    description:
      'Retrieve relevant memories from past conversations. Use when the user references something you no longer have in context — past decisions, preferences, projects, or events.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to look up. Be specific.' },
      },
      required: ['query'],
    },
  },
}

export const STORE_MEMORY_TOOL_NAME = 'store_memory'

export const STORE_MEMORY_SCHEMA: ToolSchema = {
  type: 'function',
  function: {
    name: 'store_memory',
    description:
      'Explicitly store a piece of information about the user into long-term memory. Use when the user shares a fact, preference, goal, or decision they want remembered.',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'The information to store. Be specific and factual.' },
        topic:   { type: 'string', description: 'Optional hint for which knowledge base topic to file this under (e.g. "preferences", "projects", "goals").' },
      },
      required: ['content'],
    },
  },
}

// ─── Options ───

export type UserMemoryOptions = {
  model:       string
  toolFilter?: ToolFilter
}

// ─── State ───

type UserMemoryState = {
  llmRef:        ActorRef<LlmProviderMsg> | null
  tools:         ToolCollection
  recallSessions:Record<string, ActorRef<MemoryRecallMsg>>
  storeSessions: Record<string, ActorRef<MemoryStoreMsg>>
}

// ─── Actor definition ───

export const createUserMemoryActor = (options: UserMemoryOptions): ActorDef<UserMemoryMsg, UserMemoryState> => {
  const { model, toolFilter } = options

  return {
    lifecycle: onLifecycle({
      start: (state, context) => {
        context.subscribe(LlmProviderTopic, (e) => ({
          type: '_llmProvider' as const,
          ref: e.ref,
        }))
        context.subscribe(ToolRegistrationTopic, (e) => {
          if (!applyToolFilter(e.name, toolFilter)) return null
          return e.ref === null
            ? { type: '_toolUnregistered' as const, name: e.name }
            : { type: '_toolRegistered' as const, name: e.name, schema: e.schema, ref: e.ref }
        })
        context.publishRetained(ToolRegistrationTopic, RECALL_MEMORY_TOOL_NAME, {
          name: RECALL_MEMORY_TOOL_NAME,
          schema: RECALL_MEMORY_SCHEMA,
          ref: context.self as unknown as ActorRef<ToolInvokeMsg>,
        })
        context.publishRetained(ToolRegistrationTopic, STORE_MEMORY_TOOL_NAME, {
          name: STORE_MEMORY_TOOL_NAME,
          schema: STORE_MEMORY_SCHEMA,
          ref: context.self as unknown as ActorRef<ToolInvokeMsg>,
        })
        return { state }
      },

      stopped: (state, context) => {
        context.deleteRetained(ToolRegistrationTopic, RECALL_MEMORY_TOOL_NAME, {
          name: RECALL_MEMORY_TOOL_NAME,
          ref: null,
        })
        context.deleteRetained(ToolRegistrationTopic, STORE_MEMORY_TOOL_NAME, {
          name: STORE_MEMORY_TOOL_NAME,
          ref: null,
        })
        return { state }
      },

      terminated: (state, event, context) => {
        const recallEntry = Object.entries(state.recallSessions).find(([_, ref]) => ref.name === event.ref.name)
        if (recallEntry) {
          const [recallId] = recallEntry
          context.log.warn('memory recall child terminated unexpectedly', { recallId })
          const { [recallId]: _dropped, ...sessions } = state.recallSessions
          return { state: { ...state, recallSessions: sessions } }
        }
        const storeEntry = Object.entries(state.storeSessions).find(([_, ref]) => ref.name === event.ref.name)
        if (storeEntry) {
          const [storeId] = storeEntry
          context.log.warn('memory store child terminated unexpectedly', { storeId })
          const { [storeId]: _dropped, ...storeSessions } = state.storeSessions
          return { state: { ...state, storeSessions } }
        }
        return { state }
      },
    }),

    handler: onMessage<UserMemoryMsg, UserMemoryState>({
      invoke: (state, msg, context) => {
        if (state.llmRef === null) {
          msg.replyTo.send({ type: 'toolError', error: 'Memory not ready' })
          return { state }
        }

        if (msg.toolName === RECALL_MEMORY_TOOL_NAME) {
          let query: string
          try {
            const args = JSON.parse(msg.arguments) as { query?: unknown }
            query = typeof args.query === 'string' ? args.query : ''
          } catch {
            msg.replyTo.send({ type: 'toolError', error: 'Invalid arguments' })
            return { state }
          }

          if (!query) {
            msg.replyTo.send({ type: 'toolError', error: 'Missing query argument' })
            return { state }
          }

          const recallId = crypto.randomUUID()
          const childRef = context.spawn(
            `memory-recall-${recallId}`,
            createMemoryRecallActor({
              recallId,
              query,
              replyTo: msg.replyTo,
              parentRef: context.self,
              llmRef: state.llmRef,
              model,
              userId: msg.userId ?? 'default',
              tools: state.tools,
            }),
            INITIAL_RECALL_STATE,
          )
          context.watch(childRef as ActorRef<unknown>)

          return {
            state: { ...state, recallSessions: { ...state.recallSessions, [recallId]: childRef } },
          }
        }

        if (msg.toolName === STORE_MEMORY_TOOL_NAME) {
          let content: string
          let topic: string | undefined
          try {
            const args = JSON.parse(msg.arguments) as { content?: unknown; topic?: unknown }
            content = typeof args.content === 'string' ? args.content : ''
            topic   = typeof args.topic   === 'string' ? args.topic   : undefined
          } catch {
            msg.replyTo.send({ type: 'toolError', error: 'Invalid arguments' })
            return { state }
          }

          if (!content) {
            msg.replyTo.send({ type: 'toolError', error: 'Missing content argument' })
            return { state }
          }

          const storeId = crypto.randomUUID()
          const childRef = context.spawn(
            `memory-store-${storeId}`,
            createMemoryStoreActor({
              storeId,
              content,
              topic,
              replyTo: msg.replyTo,
              parentRef: context.self,
              llmRef: state.llmRef,
              model,
              userId: msg.userId ?? 'default',
              tools: state.tools,
            }),
            INITIAL_STORE_STATE,
          )
          context.watch(childRef as ActorRef<unknown>)

          return {
            state: { ...state, storeSessions: { ...state.storeSessions, [storeId]: childRef } },
          }
        }

        msg.replyTo.send({ type: 'toolError', error: `Unknown tool: ${msg.toolName}` })
        return { state }
      },

      _recallDone: (state, msg, context) => {
        const ref = state.recallSessions[msg.recallId]
        if (ref) {
          context.stop(ref)
          context.unwatch(ref as ActorRef<unknown>)
        }
        const { [msg.recallId]: _dropped, ...sessions } = state.recallSessions
        return { state: { ...state, recallSessions: sessions } }
      },

      _storeDone: (state, msg, context) => {
        const ref = state.storeSessions[msg.storeId]
        if (ref) {
          context.stop(ref)
          context.unwatch(ref as ActorRef<unknown>)
        }
        const { [msg.storeId]: _dropped, ...storeSessions } = state.storeSessions
        return { state: { ...state, storeSessions } }
      },

      _llmProvider: (state, msg) => ({ state: { ...state, llmRef: msg.ref } }),

      _toolRegistered: (state, msg) => ({
        state: { ...state, tools: { ...state.tools, [msg.name]: { schema: msg.schema, ref: msg.ref } } },
      }),

      _toolUnregistered: (state, msg) => {
        const { [msg.name]: _dropped, ...rest } = state.tools
        return { state: { ...state, tools: rest } }
      },
    }),
  }
}

export const INITIAL_USER_MEMORY_STATE: UserMemoryState = {
  llmRef:        null,
  tools:         {},
  recallSessions:      {},
  storeSessions: {},
}
