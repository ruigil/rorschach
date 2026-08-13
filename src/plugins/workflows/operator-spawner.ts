import type { ActorDef, ActorRef, ActorContext } from '../../system/index.ts'
import { onLifecycle, onMessage, ask } from '../../system/index.ts'
import type { SCRInvokeMsg, SCRReply, SCRDescriptor } from '../../types/scr.ts'
import { SCRRegistrationTopic } from '../../types/scr.ts'
import { JobRegistryTopic, type JobLifecycleEvent } from '../../types/tools.ts'
import { PersistenceProviderTopic, type PersistenceMsg, type PResult } from '../../types/persistence.ts'
import { SCROperatorRunner } from './operator-runner.ts'

export type OperatorSpawnerMsg =
  | SCRInvokeMsg
  | { type: 'registerJob'; jobId: string; runId: string; urn: string }
  | { type: '_jobRegistry'; event: JobLifecycleEvent }
  | { type: '_jobResumed'; jobId: string; event: JobLifecycleEvent; mapping: { runId: string; urn: string } | null }
  | { type: '_persistenceProvider'; ref: ActorRef<PersistenceMsg> | null }

export type OperatorSpawnerState = {
  persistenceRef: ActorRef<PersistenceMsg> | null
}

const OPERATOR_URNS = [
  'scr:operator:workflows.sequence',
  'scr:operator:workflows.parallel',
  'scr:operator:workflows.map',
  'scr:operator:workflows.branch',
  'scr:operator:workflows.retry',
  'scr:operator:workflows.fallback',
] as const

const getOperatorDescriptor = (urn: string, target: ActorRef<any>): SCRDescriptor => {
  let description = ''
  let inputSchema: Record<string, any> = {}

  switch (urn) {
    case 'scr:operator:workflows.sequence':
      description = 'Executes child operands sequentially'
      inputSchema = {
        type: 'object',
        required: ['operands'],
        properties: {
          operands: {
            type: 'array',
            items: {
              type: 'object',
              required: ['urn'],
              properties: {
                urn: { type: 'string' },
                input: { type: 'object' },
              },
            },
          },
        },
      }
      break
    case 'scr:operator:workflows.parallel':
      description = 'Executes child operands concurrently'
      inputSchema = {
        type: 'object',
        required: ['operands'],
        properties: {
          operands: {
            type: 'array',
            items: {
              type: 'object',
              required: ['urn'],
              properties: {
                urn: { type: 'string' },
                input: { type: 'object' },
              },
            },
          },
        },
      }
      break
    case 'scr:operator:workflows.map':
      description = 'Executes a single URN over a list of items'
      inputSchema = {
        type: 'object',
        required: ['urn', 'items'],
        properties: {
          urn: { type: 'string' },
          items: { type: 'array' },
          concurrency: { type: 'string', enum: ['sequence', 'parallel'] },
        },
      }
      break
    case 'scr:operator:workflows.branch':
      description = 'Selects and executes a branch URN based on condition'
      inputSchema = {
        type: 'object',
        required: ['branches'],
        properties: {
          conditionUrn: { type: 'string' },
          conditionInput: { type: 'object' },
          value: {},
          expected: {},
          branches: { type: 'object' },
          defaultBranch: { type: 'string' },
        },
      }
      break
    case 'scr:operator:workflows.retry':
      description = 'Retries a failing operation'
      inputSchema = {
        type: 'object',
        required: ['urn', 'input', 'maxAttempts'],
        properties: {
          urn: { type: 'string' },
          input: {},
          maxAttempts: { type: 'number' },
          backoffMs: { type: 'number' },
        },
      }
      break
    case 'scr:operator:workflows.fallback':
      description = 'Tries operands in order until one succeeds'
      inputSchema = {
        type: 'object',
        required: ['operands'],
        properties: {
          operands: {
            type: 'array',
            items: {
              type: 'object',
              required: ['urn'],
              properties: {
                urn: { type: 'string' },
                input: { type: 'object' },
              },
            },
          },
        },
      }
      break
  }

  return {
    urn,
    kind: 'operator',
    description,
    schema: {
      inputSchema,
      outputSchema: { type: 'object' },
    },
    target,
  }
}

const registerOperators = (ctx: ActorContext<any>) => {
  for (const urn of OPERATOR_URNS) {
    ctx.publishRetained(SCRRegistrationTopic, urn, {
      type: 'register',
      descriptor: getOperatorDescriptor(urn, ctx.self),
    })
  }
}

const deregisterOperators = (ctx: ActorContext<any>) => {
  for (const urn of OPERATOR_URNS) {
    ctx.deleteRetained(SCRRegistrationTopic, urn, {
      type: 'deregister',
      urn,
    })
  }
}

export const OperatorSpawner = (): ActorDef<OperatorSpawnerMsg, OperatorSpawnerState> => {
  return {
    initialState: () => ({
      persistenceRef: null,
    }),

    lifecycle: onLifecycle({
      start: (state, ctx) => {
        ctx.subscribe(PersistenceProviderTopic, (event) => ({
          type: '_persistenceProvider' as const,
          ref: event.ref,
        }))

        ctx.subscribe(JobRegistryTopic, (event) => ({
          type: '_jobRegistry' as const,
          event,
        }))

        registerOperators(ctx)

        return { state }
      },

      stopped: (state, ctx) => {
        deregisterOperators(ctx)
        return { state }
      },
    }),

    handler: onMessage({
      invoke: (state, msg, ctx) => {
        const runId = crypto.randomUUID()
        ctx.spawn(`operator-run-${runId}`, SCROperatorRunner({
          runId,
          urn: msg.urn,
          input: msg.input,
          replyTo: msg.replyTo,
          spawnerRef: ctx.self,
          request: ctx.request,
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

          // Delete job mapping from KV store
          state.persistenceRef.send({
            type: 'kv.delete',
            key: `scr.job.${msg.jobId}`,
          })

          // Respawn the operator runner to resume
          const runnerRef = ctx.spawn(`operator-run-${runId}`, SCROperatorRunner({
            runId,
            urn,
            input: null,
            replyTo: null as any,
            spawnerRef: ctx.self,
            request: null as any,
          }))

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

      _persistenceProvider: (state, msg) => {
        return {
          state: { ...state, persistenceRef: msg.ref },
        }
      },
    }),
  }
}
