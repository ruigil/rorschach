import type { ActorDef, ActorRef } from '../../system/types.ts'
import { onLifecycle, onMessage } from '../../system/match.ts'
import { initialReactTurn } from '../../system/react-loop.ts'
import type { ToolCollection, ToolMsg } from '../../types/tools.ts'
import { ToolRegistrationTopic } from '../../types/tools.ts'
import type { LlmProviderMsg } from '../../types/llm.ts'
import { LlmProviderTopic } from '../../types/llm.ts'
import type { MemorySupervisorMsg } from './types.ts'
import {
  MEMORY_RECALL_TOOL_NAME,
  MEMORY_RECALL_SCHEMA,
  createMemoryRecallWorkerActor,
  type MemoryRecallWorkerState,
} from './memory-recall.ts'
import {
  MEMORY_STORE_TOOL_NAME,
  MEMORY_STORE_SCHEMA,
  createMemoryStoreWorkerActor,
  type MemoryStoreWorkerState,
} from './memory-store.ts'

// ─── Options ───

export type MemorySupervisorOptions = {
  model:         string
  maxToolLoops?: number
}

// ─── State ───

export type MemorySupervisorState = {
  llmRef:      ActorRef<LlmProviderMsg> | null
  recallTools: ToolCollection
  storeTools:  ToolCollection
  workerIdSeq: number
}

export const INITIAL_MEMORY_SUPERVISOR_STATE: Omit<MemorySupervisorState, 'recallTools' | 'storeTools'> = {
  llmRef:      null,
  workerIdSeq: 0,
}

// ─── Actor ───

export const createMemorySupervisorActor = (
  options: MemorySupervisorOptions,
): ActorDef<MemorySupervisorMsg, MemorySupervisorState> => {
  const { model, maxToolLoops = 25 } = options

  return {
    lifecycle: onLifecycle({
      start: (state, context) => {
        context.subscribe(LlmProviderTopic, (e) => ({ type: '_llmProvider' as const, ref: e.ref }))
        const selfAsTool = context.self as unknown as ActorRef<ToolMsg>
        context.publishRetained(ToolRegistrationTopic, MEMORY_RECALL_TOOL_NAME, {
          name:   MEMORY_RECALL_TOOL_NAME,
          schema: MEMORY_RECALL_SCHEMA,
          ref:    selfAsTool,
        })
        context.publishRetained(ToolRegistrationTopic, MEMORY_STORE_TOOL_NAME, {
          name:   MEMORY_STORE_TOOL_NAME,
          schema: MEMORY_STORE_SCHEMA,
          ref:    selfAsTool,
        })
        return { state }
      },

      stopped: (state, context) => {
        context.deleteRetained(ToolRegistrationTopic, MEMORY_RECALL_TOOL_NAME, {
          name: MEMORY_RECALL_TOOL_NAME,
          ref:  null,
        })
        context.deleteRetained(ToolRegistrationTopic, MEMORY_STORE_TOOL_NAME, {
          name: MEMORY_STORE_TOOL_NAME,
          ref:  null,
        })
        return { state }
      },
    }),

    handler: onMessage<MemorySupervisorMsg, MemorySupervisorState>({
      invoke: (state, msg, context) => {
        if (state.llmRef === null) {
          msg.replyTo.send({ type: 'toolError', error: 'Memory not ready' })
          return { state }
        }

        const nextSeq = state.workerIdSeq + 1
        const self    = context.self as ActorRef<MemorySupervisorMsg>

        if (msg.toolName === MEMORY_RECALL_TOOL_NAME) {
          const initial: MemoryRecallWorkerState = {
            llmRef:       state.llmRef,
            tools:        state.recallTools,
            model,
            maxToolLoops,
            replyTo:      null,
            userId:       '',
            turn:         initialReactTurn(),
          }
          const worker = context.spawn(
            `memory-recall-worker-${nextSeq}`,
            createMemoryRecallWorkerActor(self),
            initial,
          )
          worker.send(msg, context.messageHeaders())
          return { state: { ...state, workerIdSeq: nextSeq } }
        }

        if (msg.toolName === MEMORY_STORE_TOOL_NAME) {
          const initial: MemoryStoreWorkerState = {
            llmRef:       state.llmRef,
            tools:        state.storeTools,
            model,
            maxToolLoops,
            replyTo:      null,
            userId:       '',
            turn:         initialReactTurn(),
          }
          const worker = context.spawn(
            `memory-store-worker-${nextSeq}`,
            createMemoryStoreWorkerActor(self),
            initial,
          )
          worker.send(msg, context.messageHeaders())
          return { state: { ...state, workerIdSeq: nextSeq } }
        }

        msg.replyTo.send({ type: 'toolError', error: `Unknown memory tool: ${msg.toolName}` })
        return { state }
      },

      _workerDone: (state, msg, context) => {
        context.stop(msg.worker)
        return { state }
      },

      _llmProvider: (state, msg) =>
        ({ state: { ...state, llmRef: msg.ref } }),
    }),
  }
}
