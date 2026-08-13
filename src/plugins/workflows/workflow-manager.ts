import type { ActorDef, ActorRef } from '../../system/index.ts'
import { onLifecycle, onMessage, ask } from '../../system/index.ts'
import type { SCRInvokeMsg, SCRReply } from '../../types/scr.ts'
import { SCRRegistrationTopic } from '../../types/scr.ts'
import type { LlmProviderMsg } from '../../types/llm.ts'
import { LlmProviderTopic } from '../../types/llm.ts'
import { JobRegistryTopic, type JobLifecycleEvent } from '../../types/tools.ts'
import { PersistenceProviderTopic, type PersistenceMsg, type PResult } from '../../types/persistence.ts'
import { scanAndRegisterWorkflows } from './workflow-store.ts'
import { SCRWorkflowRunner } from './workflow-run-executor.ts'

export type WorkflowManagerMsg =
  | SCRInvokeMsg
  | { type: 'registerJob'; jobId: string; runId: string; urn: string }
  | { type: '_jobRegistry'; event: JobLifecycleEvent }
  | { type: '_jobResumed'; jobId: string; event: JobLifecycleEvent; mapping: { runId: string; urn: string } | null }
  | { type: '_llmProvider'; ref: ActorRef<LlmProviderMsg> | null }
  | { type: '_persistenceProvider'; ref: ActorRef<PersistenceMsg> | null }

export type WorkflowManagerState = {
  llmRef: ActorRef<LlmProviderMsg> | null
  persistenceRef: ActorRef<PersistenceMsg> | null
  model: string
  maxToolLoops: number
}

export const WorkflowManager = (opts: {
  model: string
  maxToolLoops: number
}): ActorDef<WorkflowManagerMsg, WorkflowManagerState> => {
  return {
    initialState: () => ({
      llmRef: null,
      persistenceRef: null,
      model: opts.model,
      maxToolLoops: opts.maxToolLoops,
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
        // Parse workflowId from URN: scr:graph:workflows.${workflowId}
        const parts = msg.urn.split('.')
        const workflowId = parts[parts.length - 1] || msg.urn

        const runId = crypto.randomUUID()
        ctx.spawn(`workflow-run-${runId}`, SCRWorkflowRunner({
          runId,
          workflowId,
          urn: msg.urn,
          input: msg.input,
          replyTo: msg.replyTo,
          llmRef: state.llmRef,
          spawnerRef: ctx.self,
          request: ctx.request,
          model: state.model,
          maxToolLoops: state.maxToolLoops,
        }))
        return { state }
      },

      registerJob: (state, msg) => {
        if (state.persistenceRef) {
          state.persistenceRef.send({
            type: 'kv.put',
            key: `scr.job.${msg.jobId}`,
            value: {
              runId: msg.runId,
              urn: msg.urn,
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
          const { runId, urn } = mapping
          const parts = urn.split('.')
          const workflowId = parts[parts.length - 1] || urn

          // Delete job mapping from KV store
          state.persistenceRef.send({
            type: 'kv.delete',
            key: `scr.job.${msg.jobId}`,
          })

          // Respawn the workflow runner to resume
          const runnerRef = ctx.spawn(`workflow-run-${runId}`, SCRWorkflowRunner({
            runId,
            workflowId,
            urn,
            input: null,
            replyTo: null as any,
            llmRef: state.llmRef,
            spawnerRef: ctx.self,
            request: null as any,
            model: state.model,
            maxToolLoops: state.maxToolLoops,
          }))

          // Send resume message to the runner
          const reply = event.status === 'completed'
            ? {
                type: 'toolResult' as const,
                result: {
                  text: event.result?.text ?? 'Success',
                  attachments: event.result?.attachments,
                  sources: event.result?.sources,
                  outputs: (event.result as any)?.outputs,
                },
              }
            : {
                type: 'toolError' as const,
                error: (event as any).error ?? 'Unknown error',
              }

          runnerRef.send({
            type: '_jobCompleted',
            jobId: msg.jobId,
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

      _persistenceProvider: (state, msg, ctx) => {
        if (msg.ref) {
          // Scan workflows in DB and publish URN descriptors
          scanAndRegisterWorkflows(msg.ref, ctx)
        }
        return {
          state: { ...state, persistenceRef: msg.ref },
        }
      },
    }),
  }
}
