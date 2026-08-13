import type { ActorDef, ActorRef } from '../../system/index.ts'
import { onLifecycle, onMessage, ask } from '../../system/index.ts'
import type { SCRInvokeMsg, SCRReply } from '../../types/scr.ts'
import { SCRRegistrationTopic } from '../../types/scr.ts'
import type { LlmProviderMsg } from '../../types/llm.ts'
import { LlmProviderTopic } from '../../types/llm.ts'
import { JobRegistryTopic, type JobLifecycleEvent } from '../../types/tools.ts'
import { PersistenceProviderTopic, type PersistenceMsg, type PResult, type PObjGetStreamPayload } from '../../types/persistence.ts'
import {
  scanAndRegisterWorkflows,
  listWorkflows,
  listWorkflowRuns,
  getWorkflowGraph,
  getWorkflowRun,
  deleteWorkflow,
  deleteWorkflowRun
} from './workflow-store.ts'
import { SCRWorkflowRunner } from './workflow-run-executor.ts'
import { HttpWsFrameTopic, type HttpWsFrameEvent, OutboundUserMessageTopic } from '../../types/events.ts'
import { WorkflowEventTopic } from './types.ts'
import { invokeSCR } from '../../system/scr/invoker.ts'
import { createMessageRequest, requestStorage } from '../../system/context/request.ts'
import type { HttpRequestMsg } from '../../types/routes.ts'

const validArtifactPath = (path: string): boolean => {
  if (!path) return false
  const parts = path.split('/')
  if (parts.length < 2) return false
  const [bucket, ...rest] = parts
  const key = rest.join('/')
  return !!bucket && !!key && !path.includes('..') && !path.includes('//')
}

import { ResolutionCache } from '../../system/scr/cache.ts'

export type WorkflowManagerMsg =
  | SCRInvokeMsg
  | { type: 'registerJob'; jobId: string; runId: string; urn: string }
  | { type: '_jobRegistry'; event: JobLifecycleEvent }
  | { type: '_jobResumed'; jobId: string; event: JobLifecycleEvent; mapping: { runId: string; urn: string } | null }
  | { type: '_llmProvider'; ref: ActorRef<LlmProviderMsg> | null }
  | { type: '_persistenceProvider'; ref: ActorRef<PersistenceMsg> | null }
  | { type: '_wsFrame'; event: HttpWsFrameEvent }
  | { type: '_runUpdated'; event: any }
  | { type: '_scrReply'; reply: SCRReply; userId: string; workflowId: string }
  | HttpRequestMsg
  | { type: 'getArtifact'; userId: string; key: string; replyTo: ActorRef<any> }
  | { type: '_reply'; replyTo: ActorRef<any>; reply: any }
  | { type: 'start'; run: any; workflow: any; replyTo: ActorRef<any> }
  | { type: 'list'; userId: string; replyTo: ActorRef<any> }
  | { type: 'get'; userId: string; runId: string; replyTo: ActorRef<any> }
  | { type: 'resume'; userId: string; runId: string; replyTo: ActorRef<any> }
  | { type: 'listAgentModes'; replyTo: ActorRef<any> }
  | { type: 'listExecutionTools'; replyTo: ActorRef<any> }

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

        ctx.subscribe(HttpWsFrameTopic, (event) => ({
          type: '_wsFrame' as const,
          event,
        }))

        ctx.subscribe(WorkflowEventTopic, (event) => ({
          type: '_runUpdated' as const,
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

      _wsFrame: (state, msg, ctx) => {
        const { userId, frame } = msg.event
        if (!frame.type.startsWith('workflow.')) return { state }

        const sendFrame = (reply: object) => {
          ctx.publish(OutboundUserMessageTopic, { userId, text: JSON.stringify(reply) })
        }

        if (!state.persistenceRef) {
          sendFrame({ type: 'workflow.error', message: 'Persistence not ready' })
          return { state }
        }
        const dl = state.persistenceRef

        const handle = async () => {
          if (frame.type === 'workflow.list.request') {
            const list = await listWorkflows(dl, userId)
            sendFrame({ type: 'workflows.list', workflows: list })
          } else if (frame.type === 'workflow.runs.request') {
            const list = await listWorkflowRuns(dl, userId)
            sendFrame({ type: 'workflow.runs.list', runs: list })
          } else if (frame.type === 'workflow.graph.request') {
            const { workflowId, runId } = frame
            let run = undefined
            if (runId) {
              const runRes = await getWorkflowRun(dl, userId, runId)
              if (runRes.ok) run = runRes.data
            }
            const res = await getWorkflowGraph(dl, userId, workflowId, run)
            if (res.ok) {
              sendFrame({ type: 'workflow.graph', workflowId, runId, ...res.data.graph })
            } else {
              sendFrame({ type: 'workflow.error', message: res.error })
            }
          } else if (frame.type === 'workflow.start.request') {
            const req = createMessageRequest({
              userId,
              permission: ctx.request?.permission ?? { grants: ['*'] }
            })
            ctx.pipeToSelf(
              requestStorage.run(req, () =>
                invokeSCR(`scr:graph:workflows.${frame.workflowId}`, frame.inputs)
              ),
              (reply) => ({ type: '_scrReply' as const, reply, userId, workflowId: frame.workflowId }),
              (err) => ({ type: '_scrReply' as const, reply: { type: 'error', error: String(err) }, userId, workflowId: frame.workflowId })
            )
          } else if (frame.type === 'workflow.resume.request') {
            const runRes = await getWorkflowRun(dl, userId, frame.runId)
            if (!runRes.ok) {
              sendFrame({ type: 'workflow.error', message: runRes.error })
              return
            }
            const run = runRes.data
            ctx.spawn(`workflow-run-${frame.runId}`, SCRWorkflowRunner({
              runId: frame.runId,
              workflowId: run.workflowId,
              urn: `scr:graph:workflows.${run.workflowId}`,
              input: null,
              replyTo: null as any,
              llmRef: state.llmRef,
              spawnerRef: ctx.self,
              request: ctx.request,
              model: state.model,
              maxToolLoops: state.maxToolLoops,
            }))
          } else if (frame.type === 'workflow.delete.request' || frame.type === 'workflow.delete') {
            const res = await deleteWorkflow(dl, userId, frame.workflowId)
            if (res.ok) {
              const list = await listWorkflows(dl, userId)
              sendFrame({ type: 'workflows.list', workflows: list })
            } else {
              sendFrame({ type: 'workflow.error', message: res.error })
            }
          } else if (frame.type === 'workflow.run.delete.request' || frame.type === 'workflow.run.delete') {
            const res = await deleteWorkflowRun(dl, userId, frame.runId)
            if (res.ok) {
              const list = await listWorkflowRuns(dl, userId)
              sendFrame({ type: 'workflow.runs.list', runs: list })
            } else {
              sendFrame({ type: 'workflow.error', message: res.error })
            }
          }
        }

        handle().catch(err => sendFrame({ type: 'workflow.error', message: String(err) }))
        return { state }
      },

      _runUpdated: (state, msg, ctx) => {
        const { userId, workflowId, runId, run } = msg.event
        if (run && runId) {
          const text = JSON.stringify({
            type: 'workflow.run.updated',
            workflowId,
            runId,
            run,
          })
          ctx.publish(OutboundUserMessageTopic, { userId, text })
        } else {
          const text = JSON.stringify({
            type: 'workflow.graph',
            workflowId,
            ...(runId ? { runId } : {}),
          })
          ctx.publish(OutboundUserMessageTopic, { userId, text })
        }
        return { state }
      },

      _scrReply: (state, msg, ctx) => {
        const { reply, userId } = msg
        if (reply.type === 'error') {
          ctx.publish(OutboundUserMessageTopic, {
            userId,
            text: JSON.stringify({ type: 'workflow.error', message: reply.error })
          })
        }
        return { state }
      },

      'http.request': (state, message, ctx) => {
        const { request, replyTo } = message
        const url = new URL(request.url, 'http://localhost')
        const pathname = url.pathname

        if (request.method === 'GET' && pathname === '/artifact') {
          const artifactKey = url.searchParams.get('key')
          if (!artifactKey || !validArtifactPath(artifactKey)) {
            replyTo.send({ type: 'http.response', response: { status: 400, headers: {}, body: 'Invalid artifact key' } })
            return { state }
          }

          ctx.self.send({
            type: 'getArtifact',
            userId: ctx.request.userId,
            key: artifactKey,
            replyTo: {
              name: 'http:workflow-runs:getArtifact',
              isAlive: () => true,
              send: (artifactReply) => {
                if (!artifactReply.ok) {
                  replyTo.send({ type: 'http.response', response: { status: 404, headers: {}, body: artifactReply.error ?? 'Artifact not found' } })
                  return
                }
                if (!('stream' in artifactReply)) {
                  replyTo.send({ type: 'http.response', response: { status: 500, headers: {}, body: 'Unexpected artifact response' } })
                  return
                }

                replyTo.send({
                  type: 'http.response',
                  response: {
                    status: 200,
                    headers: { 'Content-Type': artifactReply.mimeType ?? 'application/octet-stream' },
                    body: artifactReply.stream,
                  }
                })
              }
            }
          })
        } else {
          replyTo.send({ type: 'http.response', response: { status: 404, headers: {}, body: 'Not Found' } })
        }
        return { state }
      },

      getArtifact: (state, msg, ctx) => {
        if (!state.persistenceRef) {
          msg.replyTo.send({ ok: false, error: 'Persistence not ready' })
          return { state }
        }
        const cleanKey = msg.key.replace(/^\/+/, '')
        const [bucket, ...rest] = cleanKey.split('/')
        const bucketName = bucket || 'workflow-runs'
        const keyName = rest.join('/')

        ctx.pipeToSelf(
          ask<PersistenceMsg, PResult<PObjGetStreamPayload>>(
            state.persistenceRef,
            (replyTo) => ({
              type: 'obj.getStream',
              bucket: bucketName,
              key: keyName,
              replyTo,
            }),
            { timeoutMs: 10_000 }
          ),
          reply => {
            if (reply.ok && reply.data) {
              return {
                type: '_reply' as const,
                replyTo: msg.replyTo,
                reply: {
                  ok: true as const,
                  stream: reply.data.stream,
                  mimeType: reply.data.meta?.contentType || reply.data.meta?.mimeType || 'application/octet-stream'
                }
              }
            }
            return {
              type: '_reply' as const,
              replyTo: msg.replyTo,
              reply: {
                ok: false as const,
                error: reply.ok ? 'No data' : reply.error
              }
            }
          },
          error => ({
            type: '_reply' as const,
            replyTo: msg.replyTo,
            reply: { ok: false as const, error: String(error) }
          })
        )
        return { state }
      },

      _reply: (state, msg) => {
        msg.replyTo.send(msg.reply)
        return { state }
      },

      listAgentModes: (state, msg) => {
        const agentModes = ResolutionCache.getAllDescriptors()
          .filter(d => d.kind === 'reasoner')
          .map(d => ({
            mode: d.urn.replace('scr:reasoner:', ''),
            displayName: d.meta?.agentDescriptor?.displayName || d.description || d.urn,
          }))

        msg.replyTo.send({
          ok: true,
          agentModes,
        })
        return { state }
      },

      listExecutionTools: (state, msg) => {
        const executionTools = ResolutionCache.getAllDescriptors()
          .filter(d => d.kind === 'leaf')
          .map(d => ({
            name: d.urn.replace('scr:leaf:', '').replace(/\./g, '_'),
            schema: d.meta?.schema || {
              type: 'function',
              function: {
                name: d.urn.replace('scr:leaf:', '').replace(/\./g, '_'),
                description: d.description,
                parameters: d.schema.inputSchema || {},
              }
            }
          }))

        msg.replyTo.send({
          ok: true,
          executionTools,
        })
        return { state }
      },

      start: (state, msg, ctx) => {
        const runId = msg.run.runId
        ctx.spawn(`workflow-run-${runId}`, SCRWorkflowRunner({
          runId,
          workflowId: msg.workflow.id,
          urn: `scr:graph:workflows.${msg.workflow.id}`,
          input: msg.run.inputs,
          replyTo: msg.replyTo as any,
          llmRef: state.llmRef,
          spawnerRef: ctx.self,
          request: ctx.request,
          model: state.model,
          maxToolLoops: state.maxToolLoops,
        }))
        return { state }
      },

      list: (state, msg) => {
        if (!state.persistenceRef) {
          msg.replyTo.send({ ok: false, error: 'Persistence not available' })
          return { state }
        }
        listWorkflowRuns(state.persistenceRef, msg.userId)
          .then(runs => msg.replyTo.send({ ok: true, runs }))
          .catch(err => msg.replyTo.send({ ok: false, error: err.message }))
        return { state }
      },

      get: (state, msg) => {
        if (!state.persistenceRef) {
          msg.replyTo.send({ ok: false, error: 'Persistence not available' })
          return { state }
        }
        getWorkflowRun(state.persistenceRef, msg.userId, msg.runId)
          .then(res => {
            if (res.ok && res.data) {
              msg.replyTo.send({ ok: true, run: res.data })
            } else {
              msg.replyTo.send({ ok: false, error: res.ok ? 'Run not found' : res.error })
            }
          })
          .catch(err => msg.replyTo.send({ ok: false, error: err.message }))
        return { state }
      },

      resume: (state, msg, ctx) => {
        if (!state.persistenceRef) {
          msg.replyTo.send({ ok: false, error: 'Persistence not available' })
          return { state }
        }
        getWorkflowRun(state.persistenceRef, msg.userId, msg.runId)
          .then(res => {
            if (res.ok && res.data) {
              const run = res.data
              const workflowId = run.workflowId
              const urn = `scr:graph:workflows.${workflowId}`
              ctx.spawn(`workflow-run-${msg.runId}`, SCRWorkflowRunner({
                runId: msg.runId,
                workflowId,
                urn,
                input: null,
                replyTo: msg.replyTo as any,
                llmRef: state.llmRef,
                spawnerRef: ctx.self,
                request: ctx.request,
                model: state.model,
                maxToolLoops: state.maxToolLoops,
              }))
            } else {
              msg.replyTo.send({ ok: false, error: res.ok ? 'Run not found' : res.error })
            }
          })
          .catch(err => msg.replyTo.send({ ok: false, error: err.message }))
        return { state }
      },
    }),
  }
}

