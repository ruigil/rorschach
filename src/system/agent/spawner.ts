import type { ActorDef, ActorRef } from '../actor/types.ts'
import { onLifecycle, onMessage } from '../actor/match.ts'
import type { SCRInvokeMsg, SCRReply } from '../../types/scr.ts'
import type { LlmProviderMsg } from '../../types/llm.ts'
import { LlmProviderTopic } from '../../types/llm.ts'
import { SCRAgentRunner } from './agent-runner.ts'
import { JobRegistryTopic, type JobLifecycleEvent } from '../../types/tools.ts'
import { PersistenceProviderTopic, type PersistenceMsg, type PResult } from '../../types/persistence.ts'
import { ask } from '../actor/ask.ts'

export type AgentSpawnerMsg =
  | SCRInvokeMsg
  | { type: 'registerJob'; jobId: string; runId: string; urn: string; toolCallId: string; toolName: string }
  | { type: '_jobRegistry'; event: JobLifecycleEvent }
  | { type: '_jobResumed'; jobId: string; event: JobLifecycleEvent; mapping: { runId: string; urn: string; toolCallId: string; toolName: string } | null }
  | { type: '_llmProvider'; ref: ActorRef<LlmProviderMsg> | null }
  | { type: '_persistenceProvider'; ref: ActorRef<PersistenceMsg> | null }

export type AgentSpawnerState = {
  llmRef: ActorRef<LlmProviderMsg> | null
  persistenceRef: ActorRef<PersistenceMsg> | null
}

export const AgentSpawner = (opts: { llmRef: ActorRef<LlmProviderMsg> | null }): ActorDef<AgentSpawnerMsg, AgentSpawnerState> => {
  return {
    initialState: () => ({
      llmRef: opts.llmRef,
      persistenceRef: null,
    }),

    lifecycle: onLifecycle({
      start: (state, ctx) => {
        ctx.subscribe(PersistenceProviderTopic, (event) => ({
          type: '_persistenceProvider' as const,
          ref: event.ref,
        }))

        ctx.subscribe(LlmProviderTopic, (event) => ({
          type: '_llmProvider' as const,
          ref: event.ref,
        }))

        ctx.subscribe(JobRegistryTopic, (event) => ({
          type: '_jobRegistry' as const,
          event,
        }))

        return { state }
      },
    }),

    handler: onMessage({
      invoke: (state, msg, ctx) => {
        const runId = crypto.randomUUID()
        ctx.spawn(`agent-runner-${runId}`, SCRAgentRunner({
          runId,
          urn: msg.urn,
          input: msg.input,
          replyTo: msg.replyTo,
          llmRef: state.llmRef,
          request: ctx.request,
          spawnerRef: ctx.self,
        }))
        return { state }
      },

      registerJob: (state, msg, ctx) => {
        if (state.persistenceRef) {
          state.persistenceRef.send({
            type: 'kv.put',
            key: `scr.job.${msg.jobId}`,
            value: {
              runId: msg.runId,
              urn: msg.urn,
              toolCallId: msg.toolCallId,
              toolName: msg.toolName,
            },
          })
        }
        return { state }
      },

      _jobRegistry: (state, msg, ctx) => {
        const { event } = msg
        if ((event.status === 'completed' || event.status === 'failed') && state.persistenceRef) {
          const persist = state.persistenceRef
          const jobId = event.jobId
          const promise = ask<PersistenceMsg, PResult<unknown>>(persist, (replyTo) => ({
            type: 'kv.get',
            key: `scr.job.${jobId}`,
            replyTo,
          }))

          ctx.pipeToSelf(
            promise,
            (res) => ({
              type: '_jobResumed' as const,
              jobId,
              event,
              mapping: res.ok ? res.data as any : null,
            }),
            () => ({
              type: '_jobResumed' as const,
              jobId,
              event,
              mapping: null,
            })
          )
        }
        return { state }
      },

      _jobResumed: (state, msg, ctx) => {
        const { mapping, event } = msg
        if (mapping && state.persistenceRef) {
          const { runId, urn, toolCallId, toolName } = mapping

          // Delete job mapping from KV store
          state.persistenceRef.send({
            type: 'kv.delete',
            key: `scr.job.${msg.jobId}`,
          })

          // Respawn the agent runner
          const runnerRef = ctx.spawn(`agent-runner-${runId}`, SCRAgentRunner({
            runId,
            urn,
            input: null,
            replyTo: null as any,
            llmRef: state.llmRef,
            request: null as any,
            spawnerRef: ctx.self,
          }))

          // Format tool reply
          const reply: SCRReply = event.status === 'completed'
            ? {
                type: 'result',
                output: {
                  text: event.result?.text ?? 'Success',
                  attachments: event.result?.attachments,
                  sources: event.result?.sources,
                },
              }
            : {
                type: 'error',
                error: (event as any).error ?? 'Unknown error',
              }

          // Send the _toolResult message to the runner to resume its loop
          runnerRef.send({
            type: '_toolResult',
            toolName,
            toolCallId,
            reply,
          } as any)
        }
        return { state }
      },

      _llmProvider: (state, msg) => {
        return {
          state: { ...state, llmRef: msg.ref },
        }
      },

      _persistenceProvider: (state, msg) => {
        return {
          state: { ...state, persistenceRef: msg.ref },
        }
      },
    }),
  }
}
