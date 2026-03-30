import type { ActorDef, ActorRef } from '../../system/types.ts'
import { onLifecycle, onMessage } from '../../system/match.ts'
import type { ToolCollection, ToolEntry, ToolFilter, ToolInvokeMsg, ToolReply, ToolSchema } from '../../types/tools.ts'
import { applyToolFilter, ToolRegistrationTopic } from '../../types/tools.ts'
import type { LlmProviderMsg } from '../../types/llm.ts'
import { LlmProviderTopic } from '../../types/llm.ts'
import { createMemoryRecallActor, INITIAL_RECALL_STATE } from './memory-recall.ts'
import type { MemoryRecallMsg } from '../../types/memory.ts'
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

// ─── Options ───

export type UserMemoryOptions = {
  model:       string
  userId:      string
  toolFilter?: ToolFilter
}

// ─── State ───

type UserMemoryState = {
  llmRef:   ActorRef<LlmProviderMsg> | null
  tools:    ToolCollection
  sessions: Record<string, ActorRef<MemoryRecallMsg>>
}

// ─── Actor definition ───

export const createUserMemoryActor = (options: UserMemoryOptions): ActorDef<UserMemoryMsg, UserMemoryState> => {
  const { model, userId, toolFilter } = options

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
        return { state }
      },

      stopped: (state, context) => {
        context.deleteRetained(ToolRegistrationTopic, RECALL_MEMORY_TOOL_NAME, {
          name: RECALL_MEMORY_TOOL_NAME,
          ref: null,
        })
        return { state }
      },

      terminated: (state, event, context) => {
        const entry = Object.entries(state.sessions).find(([_, ref]) => ref.name === event.ref.name)
        if (!entry) return { state }
        const [recallId] = entry
        context.log.warn('memory recall child terminated unexpectedly', { recallId })
        const { [recallId]: _dropped, ...sessions } = state.sessions
        return { state: { ...state, sessions } }
      },
    }),

    handler: onMessage<UserMemoryMsg, UserMemoryState>({
      invoke: (state, msg, context) => {
        if (state.llmRef === null) {
          msg.replyTo.send({ type: 'toolError', error: 'Memory not ready' })
          return { state }
        }

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
            userId,
            tools: state.tools,
          }),
          INITIAL_RECALL_STATE,
        )
        context.watch(childRef as ActorRef<unknown>)

        return {
          state: { ...state, sessions: { ...state.sessions, [recallId]: childRef } },
        }
      },

      _recallDone: (state, msg, context) => {
        const ref = state.sessions[msg.recallId]
        if (ref) {
          context.stop(ref)
          context.unwatch(ref as ActorRef<unknown>)
        }
        const { [msg.recallId]: _dropped, ...sessions } = state.sessions
        return { state: { ...state, sessions } }
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
  llmRef:   null,
  tools:    {},
  sessions: {},
}
