import type { ActorDef, ActorRef, ActorContext, ActorResult, Interceptor, LoopState } from '../../system/index.ts'
import { onLifecycle } from '../../system/index.ts'
import { agentLoop, idleLoopState, applyToolFilter, assembleAgentMessages, assembleUserText, type ContextView } from '../../system/index.ts'
import { OutboundUserMessageTopic } from '../../types/events.ts'
import type { ToolCollection, ToolFilter, ToolMsg } from '../../types/tools.ts'
import { ToolRegistrationTopic } from '../../types/tools.ts'
import type { ApiMessage } from '../../types/llm.ts'
import { ContextSnapshotTopic, type AgentFactoryOpts, type AgentModelOptions } from '../../types/agents.ts'
import type { WorkflowRunnerMsg } from './types.ts'
import {
  saveWorkflowTool,
  updateWorkflowTool,
} from './workflow-tools.ts'
import type { WorkflowsAgentMsg } from './types.ts'

type WorkflowsAgentState = {
  loop: LoopState
  contextView: ContextView
  tools: ToolCollection
  pendingSaveSummary: string | null
}
export type WorkflowsAgentOptions = AgentModelOptions & {
  workflowsDir: string
  workflowRunnerRef: ActorRef<WorkflowRunnerMsg>
  tools: ToolCollection
}

const WORKFLOWS_MODE = 'workflows'

const emptyContextView = (userId = ''): ContextView => ({
  userId,
  version: 0,
  recentMessages: [],
  userContext: null,
  toolSummaries: [],
})

const buildSystemPrompt = (): string =>
  `You are a workflow assistant. Today is ${new Date().toDateString()}.

You help the user design, save, inspect, and run workflows.

Workflow rules:
- A workflow is a static DAG of tasks plus an executionTools allowlist.
- Use list_execution_tools before choosing executionTools.
- Do not call execution tools yourself. You may only save them into executionTools for task executors.
- Ask for confirmation before saving workflows that require privileged or mutating tools.
- Save only after the user accepts the workflow.
- Tasks must have id, name, description, validationCriteria, and dependencies.
- Workflows may declare inputs, final outputs, and per-task outputs using value specs.
- Use explicit task output names when later tasks or final workflow outputs depend on them.
- Workflow final outputs resolve from same-named task outputs.
- Artifact-producing tasks may write files under /workspace/workflows/runs/<runId> using an allowed execution tool and return path artifact references, or use public URLs returned by tools and return URL artifact references. Do not inline HTML, markdown, images, or generated documents as artifact outputs.
- Artifact-consuming tasks need an allowed read-capable execution tool.

After save_workflow or update_workflow, briefly acknowledge the save and stop.`

export const WorkflowsAgentFactory = (options: WorkflowsAgentOptions) =>
  (opts: AgentFactoryOpts): ActorDef<WorkflowsAgentMsg, WorkflowsAgentState> => WorkflowsAgent(options, opts)

const WorkflowsAgent = (options: WorkflowsAgentOptions, opts: AgentFactoryOpts): ActorDef<WorkflowsAgentMsg, WorkflowsAgentState> => {
  const { model, maxToolLoops, toolFilter, tools: initialTools } = options
  const { userId, contextStoreRef, llmRef } = opts

  type M = WorkflowsAgentMsg
  type S = WorkflowsAgentState
  type Ctx = ActorContext<M>

  const buildTurnMessages = (state: S, userMsg: ApiMessage): ApiMessage[] =>
    assembleAgentMessages(state.contextView, {
      mode: WORKFLOWS_MODE,
      systemPrompt: buildSystemPrompt(),
      includeToolSummaries: true,
    }, userMsg)

  const handleUserMessage = (state: S, msg: Extract<M, { type: 'userMessage' }>, ctx: Ctx): ActorResult<M, S> => {
    const userText = assembleUserText(msg.text, msg.attachments)
    const userMsg: ApiMessage = { role: 'user', content: userText }
    contextStoreRef.send({ type: 'append', mode: WORKFLOWS_MODE, source: 'user', injected: msg.isInjected || false, messages: [userMsg] })
    return loop.startTurn(state, {
      messages: buildTurnMessages(state, userMsg),
      userId,
    }, ctx)
  }

  const loop = agentLoop<S, M>({
    role: 'workflows',
    spanName: 'workflows-turn',
    logPrefix: 'workflows',
    model,
    maxToolLoops: maxToolLoops ?? 10,
    llmRef: () => llmRef,
    tools: state => state.tools,
    uiEvents: OutboundUserMessageTopic,
    errorMessages: {
      llm: 'The workflows agent encountered an error. Please try again.',
      loopLimit: 'Tool loop limit reached in workflows. Please try again.',
    },
    onComplete: (state, finalText) => {
      if (state.pendingSaveSummary) {
        contextStoreRef.send({
          type: 'append',
          mode: WORKFLOWS_MODE,
          source: 'assistant',
          messages: [{ role: 'assistant', content: state.pendingSaveSummary }],
        })
        return { state: { ...state, pendingSaveSummary: null } }
      }
      if (finalText) {
        contextStoreRef.send({ type: 'append', mode: WORKFLOWS_MODE, source: 'assistant', messages: [{ role: 'assistant', content: finalText }] })
      }
      return { state }
    },
    onError: state => ({ state }),
    onBatchHistoryReady: (state, messages) => {
      contextStoreRef.send({ type: 'append', mode: WORKFLOWS_MODE, messages })
      return { state }
    },
    onToolResult: (state, result) => {
      if ((result.toolName === saveWorkflowTool.name || result.toolName === updateWorkflowTool.name) && result.reply.type === 'toolResult') {
        return { state: { ...state, pendingSaveSummary: result.reply.result.text } }
      }
      return { state }
    },
    onToolPending: (state, pending) => {
      const text = pending.placeholderText ?? `Background job started for ${pending.toolName} (jobId=${pending.jobId}).`
      contextStoreRef.send({
        type: 'append',
        mode: WORKFLOWS_MODE,
        source: 'assistant',
        messages: [{ role: 'assistant', content: text }],
      })
      return { state }
    },
  })

  const host: Interceptor<M, S> = (state, msg, ctx, next) => {
    if (msg.type === 'userMessage') {
      if (state.loop.phase !== 'idle') return { state, stash: true }
      return handleUserMessage(state, msg, ctx)
    }
    if (msg.type === '_contextSnapshot') {
      return {
        state: {
          ...state,
          contextView: {
            userId: msg.userId,
            version: msg.version,
            recentMessages: msg.recentMessages,
            userContext: msg.userContext,
            toolSummaries: msg.toolSummaries,
          },
        },
      }
    }
    if (msg.type === '_toolRegistered') {
      return {
        state: {
          ...state,
          tools: {
            ...state.tools,
            [msg.name]: { name: msg.name, schema: msg.schema, ref: msg.ref, mayBeLongRunning: msg.mayBeLongRunning },
          },
        },
      }
    }
    if (msg.type === '_toolUnregistered') {
      const { [msg.name]: _, ...tools } = state.tools
      return { state: { ...state, tools } }
    }
    return next(state, msg)
  }

  return {
    initialState: () => ({
      loop: idleLoopState(),
      contextView: emptyContextView(userId),
      tools: {},
      pendingSaveSummary: null,
    }),
    lifecycle: onLifecycle({
      start: (state, ctx) => {
        ctx.subscribe(ContextSnapshotTopic, event => event.userId === userId ? { type: '_contextSnapshot' as const, ...event } : null)
        ctx.subscribe(ToolRegistrationTopic, event => {
          if (!applyToolFilter(event.name, toolFilter)) return null
          if ('schema' in event) {
            return {
              type: '_toolRegistered' as const,
              name: event.name,
              schema: event.schema,
              ref: event.ref,
              mayBeLongRunning: event.mayBeLongRunning,
            }
          }
          return { type: '_toolUnregistered' as const, name: event.name }
        })

        return {
          state: {
            ...state,
            tools: {
              ...initialTools,
              ...state.tools,
            },
          },
        }
      },
    }),
    handler: loop.idle,
    interceptors: [host],
    supervision: { type: 'restart', maxRetries: 3, withinMs: 30_000 },
  }
}
