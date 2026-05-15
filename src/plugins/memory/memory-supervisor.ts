import type { ActorDef, ActorRef } from '../../system/types.ts'
import { onLifecycle, onMessage } from '../../system/match.ts'
import type { ToolMsg, ToolCollection } from '../../types/tools.ts'
import { ToolRegistrationTopic } from '../../types/tools.ts'
import type { LlmProviderMsg } from '../../types/llm.ts'
import { LlmProviderTopic } from '../../types/llm.ts'
import type { MemorySupervisorMsg } from './types.ts'
import {
  memoryRecallTool,
  MemoryRecallWorker,
} from './memory-recall.ts'
import {
  memoryStoreTool,
  MemoryStoreWorker,
} from './memory-store.ts'

// ─── Options ───

export type MemorySupervisorOptions = {
  model:         string
  recallTools:   ToolCollection
  storeTools:    ToolCollection
  maxToolLoops?: number
}

// ─── State ───

export type MemorySupervisorState = {
  llmRef:      ActorRef<LlmProviderMsg> | null
  recallTools: ToolCollection
  storeTools:  ToolCollection
  workerIdSeq: number
}

// ─── Actor ───

export const MemorySupervisor = (
  options: MemorySupervisorOptions,
): ActorDef<MemorySupervisorMsg, MemorySupervisorState> => {
  const { model, recallTools, storeTools, maxToolLoops = 25 } = options

  return {
    initialState: {
      llmRef:      null,
      recallTools,
      storeTools,
      workerIdSeq: 0,
    },
    lifecycle: onLifecycle({
      start: (state, context) => {
        context.subscribe(LlmProviderTopic, (e) => ({ type: '_llmProvider' as const, ref: e.ref }))
        const selfAsTool = context.self as unknown as ActorRef<ToolMsg>
        context.publishRetained(ToolRegistrationTopic, memoryRecallTool.name, {
          ...memoryRecallTool,
          ref: selfAsTool,
        })
        context.publishRetained(ToolRegistrationTopic, memoryStoreTool.name, {
          ...memoryStoreTool,
          ref: selfAsTool,
        })
        return { state }
      },

      stopped: (state, context) => {
        context.deleteRetained(ToolRegistrationTopic, memoryRecallTool.name, {
          name: memoryRecallTool.name,
          ref:  null,
        })
        context.deleteRetained(ToolRegistrationTopic, memoryStoreTool.name, {
          name: memoryStoreTool.name,
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

        if (msg.toolName === memoryRecallTool.name) {
          const opts = { model, maxToolLoops, tools: state.recallTools, llmRef: state.llmRef }
          const worker = context.spawn(
            `memory-recall-worker-${nextSeq}`,
            MemoryRecallWorker(self, opts),
          )
          worker.send(msg, context.messageHeaders())
          return { state: { ...state, workerIdSeq: nextSeq } }
        }

        if (msg.toolName === memoryStoreTool.name) {
          const opts = { model, maxToolLoops, tools: state.storeTools, llmRef: state.llmRef }
          const worker = context.spawn(
            `memory-store-worker-${nextSeq}`,
            MemoryStoreWorker(self, opts),
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
