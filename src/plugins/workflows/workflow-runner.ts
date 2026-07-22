import type { ActorContext, ActorDef, ActorRef, ActorResult } from '../../system/index.ts'
import { ask, onLifecycle, onMessage } from '../../system/index.ts'
import { ToolRegistrationTopic, type ToolCollection } from '../../types/tools.ts'
import { OutboundUserMessageTopic, HttpWsFrameTopic } from '../../types/events.ts'
import { LlmProviderTopic, type LlmProviderMsg } from '../../types/llm.ts'
import { AgentRegistrationTopic, type AgentDescriptor } from '../../types/agents.ts'
import { WorkflowEventTopic } from './types.ts'
import { TOOL_EXECUTOR_DESCRIPTOR } from './workflow-task-executor.ts'
import type {
  WorkflowRunExecutorMsg,
  WorkflowRunExecutorReply,
  WorkflowRunnerMsg,
  WorkflowRunnerReply,
  ExecutionToolSummary,
  AgentModeSummary,
  WorkflowRunnerConfig,
} from './types.ts'
import { WorkflowRunExecutor } from './workflow-run-executor.ts'
import { getWorkflowRun, listWorkflowRuns, listWorkflows, getWorkflowGraph, createWorkflowRun, deleteWorkflow, deleteWorkflowRun } from './workflow-store.ts'
import { PersistenceProviderTopic, type PersistenceMsg, type PResult, type PObjGetStreamPayload } from '../../types/persistence.ts'
import { validArtifactPath } from './validation.ts'

type RunnerState = {
  live: Record<string, ActorRef<WorkflowRunExecutorMsg>>
  executionTools: ToolCollection
  llmRef: ActorRef<LlmProviderMsg> | null
  persistenceRef: ActorRef<any> | null
  descriptors: Record<string, AgentDescriptor>
}

const summarizeExecutionTools = (tools: ToolCollection): ExecutionToolSummary[] =>
  Object.values(tools).map(tool => ({
    name: tool.name,
    description: tool.schema.function.description,
    mayBeLongRunning: tool.mayBeLongRunning,
  }))

const summarizeAgentModes = (descriptors: Record<string, AgentDescriptor>): AgentModeSummary[] =>
  Object.values(descriptors).map(desc => ({
    mode: desc.mode,
    displayName: desc.displayName,
    shortDesc: desc.shortDesc,
  }))

export const WorkflowRunner = (config: WorkflowRunnerConfig ): ActorDef<WorkflowRunnerMsg, RunnerState> => {
  const { model, maxToolLoops } = config

  const ensureRunActor = (
    state: RunnerState,
    ctx: ActorContext<WorkflowRunnerMsg>,
    userId: string,
    runId: string,
  ): { ref: ActorRef<WorkflowRunExecutorMsg>; spawned: boolean } => {
    const live = state.live[runId]
    if (live) return { ref: live, spawned: false }

    const ref = ctx.spawn(
      `workflow-run-${runId}`,
      WorkflowRunExecutor(state.llmRef, model, maxToolLoops, state.executionTools, userId, runId),
    ) as ActorRef<WorkflowRunExecutorMsg>
    return { ref, spawned: true }
  }

  const listRuns = (
    state: RunnerState,
    msg: Extract<WorkflowRunnerMsg, { type: 'list' }>,
    ctx: ActorContext<WorkflowRunnerMsg>,
  ): ActorResult<WorkflowRunnerMsg, RunnerState> => {
    if (!state.persistenceRef) {
      msg.replyTo.send({ ok: false, error: 'Persistence not ready' })
      return { state }
    }
    ctx.pipeToSelf(
      listWorkflowRuns(state.persistenceRef, msg.userId),
      runs => {
        msg.replyTo.send({ ok: true, runs })
        return { type: '_done' }
      },
      error => {
        msg.replyTo.send({ ok: false, error: String(error) })
        return { type: '_done' }
      },
    )
    return { state }
  }

  const startRun = (
    state: RunnerState,
    msg: Extract<WorkflowRunnerMsg, { type: 'start' }>,
    ctx: ActorContext<WorkflowRunnerMsg>,
  ): ActorResult<WorkflowRunnerMsg, RunnerState> => {
    const runId = msg.run.runId
    if (state.live[runId]) {
      msg.replyTo.send({ ok: false, error: `Workflow run ${runId} is already active.`, status: 409 })
      return { state }
    }

    const ref = ctx.spawn(
      `workflow-run-${runId}`,
      WorkflowRunExecutor(state.llmRef, model, maxToolLoops, state.executionTools, msg.run.userId, runId),
    ) as ActorRef<WorkflowRunExecutorMsg>

    const nextState = { ...state, live: { ...state.live, [runId]: ref } }

    ctx.pipeToSelf(
      ask<WorkflowRunExecutorMsg, WorkflowRunExecutorReply>(
        ref,
        replyTo => ({ type: 'start', replyTo }),
        { timeoutMs: 5_000 },
      ),
      reply => ({ type: '_reply' as const, replyTo: msg.replyTo, reply }),
      error => ({ type: '_reply' as const, replyTo: msg.replyTo, reply: { ok: false as const, error: String(error) } }),
    )
    return { state: nextState }
  }

  const getRun = (
    state: RunnerState,
    msg: Extract<WorkflowRunnerMsg, { type: 'get' }>,
    ctx: ActorContext<WorkflowRunnerMsg>,
  ): ActorResult<WorkflowRunnerMsg, RunnerState> => {
    if (!state.persistenceRef) {
      msg.replyTo.send({ ok: false, error: 'Persistence not ready' })
      return { state }
    }
    ctx.pipeToSelf(
      (async (): Promise<WorkflowRunnerReply> => {
        const live = state.live[msg.runId]
        if (live) {
          const reply = await ask<WorkflowRunExecutorMsg, WorkflowRunExecutorReply>(live, replyTo => ({ type: 'get', replyTo }))
          if (reply.ok) return reply
        }
        const result = await getWorkflowRun(state.persistenceRef!, msg.userId, msg.runId)
        return result.ok ? { ok: true, run: result.data } : { ok: false, error: result.error, status: 404 }
      })(),
      reply => ({ type: '_reply' as const, replyTo: msg.replyTo, reply }),
      error => ({ type: '_reply' as const, replyTo: msg.replyTo, reply: { ok: false as const, error: String(error) } }),
    )
    return { state }
  }

  const resumeRun = (
    state: RunnerState,
    msg: Extract<WorkflowRunnerMsg, { type: 'resume' }>,
    ctx: ActorContext<WorkflowRunnerMsg>,
  ): ActorResult<WorkflowRunnerMsg, RunnerState> => {
    const { ref, spawned } = ensureRunActor(state, ctx, msg.userId, msg.runId)
    const nextState = spawned ? { ...state, live: { ...state.live, [msg.runId]: ref } } : state

    ctx.pipeToSelf(
      ask<WorkflowRunExecutorMsg, WorkflowRunExecutorReply>(
        ref,
        replyTo => ({ type: 'resume', replyTo }),
        { timeoutMs: 5_000 },
      ),
      reply => ({ type: '_reply' as const, replyTo: msg.replyTo, reply }),
      error => ({ type: '_reply' as const, replyTo: msg.replyTo, reply: { ok: false as const, error: String(error) } }),
    )
    return { state: nextState }
  }

  return {
    initialState: () => ({
      live: {},
      executionTools: {},
      llmRef: null,
      persistenceRef: null,
      descriptors: {
        [TOOL_EXECUTOR_DESCRIPTOR.mode]: TOOL_EXECUTOR_DESCRIPTOR,
      },
    }),
    lifecycle: onLifecycle<WorkflowRunnerMsg, RunnerState>({
      start: (state, ctx) => {
        ctx.subscribe(LlmProviderTopic, event => ({ type: '_llmProvider' as const, ref: event.ref }))
        ctx.subscribe(ToolRegistrationTopic, toolEvent => {
          if (toolEvent && 'schema' in toolEvent && toolEvent.schema) {
            return { type: '_toolRegistered' as const, tool: toolEvent }
          }
          return { type: '_toolUnregistered' as const, name: toolEvent.name }
        })
        ctx.subscribe(WorkflowEventTopic, event => ({ type: '_runUpdated' as const, event }))
        ctx.subscribe(HttpWsFrameTopic, frameEvent => ({ type: '_wsFrame' as const, event: frameEvent }))
        ctx.subscribe(PersistenceProviderTopic, (event) => ({type: '_persistenceRef' as const, ref: event.ref }))
        ctx.subscribe(AgentRegistrationTopic, event => ({ type: '_agentRegistration' as const, event }))
        return { state }
      },
      terminated: (state, event, ctx) => {
        const parts = event.ref.name.split('/')
        const childName = parts[parts.length - 1] || ''
        const match = childName.match(/^workflow-run-(.+)$/)
        if (match && match[1]) {
          const runId = match[1]
          if (state.live[runId]) {
            const { [runId]: _, ...live } = state.live
            ctx.log.info('Workflow run executor terminated; removed from runner cache.', { runId })
            return { state: { ...state, live } }
          }
        }
        return { state }
      }
    }),
    handler: onMessage<WorkflowRunnerMsg, RunnerState>({
      'http.request': (state, message, ctx) => {
        const { request, identity, replyTo } = message
        const url = new URL(request.url, 'http://localhost')
        const pathname = url.pathname

        if (!identity) {
          replyTo.send({ type: 'http.response', response: { status: 401, headers: {}, body: 'Unauthorized' } })
          return { state }
        }

        if (request.method === 'GET' && pathname === '/artifact') {
          const artifactKey = url.searchParams.get('key')
          if (!artifactKey || !validArtifactPath(artifactKey)) {
            replyTo.send({ type: 'http.response', response: { status: 400, headers: {}, body: 'Invalid artifact key' } })
            return { state }
          }

          ctx.self.send({
            type: 'getArtifact',
            userId: identity.userId,
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

      _persistenceRef: (state, msg) => {
        return { state: { ...state, persistenceRef: msg.ref } }
      },

      _llmProvider: (state, msg) => {
        return { state: { ...state, llmRef: msg.ref } }
      },

      _toolRegistered: (state, msg) => {
        return { state: { ...state, executionTools: { ...state.executionTools, [msg.tool.name]: msg.tool } } }
      },

      _toolUnregistered: (state, msg) => {
        const { [msg.name]: _, ...executionTools } = state.executionTools
        return { state: { ...state, executionTools } }
      },

      _agentRegistration: (state, msg) => {
        const event = msg.event
        if (event.type === 'register') {
          return { state: { ...state, descriptors: { ...state.descriptors, [event.descriptor.mode]: event.descriptor } } }
        } else if (event.type === 'unregister') {
          const descriptors = { ...state.descriptors }
          delete descriptors[event.mode]
          return { state: { ...state, descriptors } }
        }
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
            const result = await createWorkflowRun(dl, userId, frame.workflowId, frame.inputs)
            if (!result.ok) {
              sendFrame({ type: 'workflow.error', message: result.error })
              return
            }
            const reply = await ask<WorkflowRunnerMsg, WorkflowRunnerReply>(
              ctx.self,
              replyTo => ({ type: 'start', run: result.data.run, workflow: result.data.workflow, replyTo }),
            )
            if (!reply.ok) {
              sendFrame({ type: 'workflow.error', message: reply.error })
            }
          } else if (frame.type === 'workflow.resume.request') {
            const reply = await ask<WorkflowRunnerMsg, WorkflowRunnerReply>(
              ctx.self,
              replyTo => ({ type: 'resume', userId, runId: frame.runId, replyTo }),
            )
            if (!reply.ok) {
              sendFrame({ type: 'workflow.error', message: reply.error })
            }
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

      start: (state, msg, ctx) => startRun(state, msg, ctx),
      list: (state, msg, ctx) => listRuns(state, msg, ctx),
      listExecutionTools: (state, msg) => {
        msg.replyTo.send({ ok: true, executionTools: summarizeExecutionTools(state.executionTools) })
        return { state }
      },
      listAgentModes: (state, msg) => {
        msg.replyTo.send({ ok: true, agentModes: summarizeAgentModes(state.descriptors) })
        return { state }
      },
      get: (state, msg, ctx) => getRun(state, msg, ctx),
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
      resume: (state, msg, ctx) => resumeRun(state, msg, ctx),
      _reply: (state, msg) => {
        msg.replyTo.send(msg.reply)
        return { state }
      },
      _done: state => ({ state }),
    }),
  }
}
