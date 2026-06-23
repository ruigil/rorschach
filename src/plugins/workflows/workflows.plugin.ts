import { join } from 'node:path'
import type { ActorContext, ActorRef, ActorSlot, PluginDef } from '../../system/index.ts'
import { createSlot, defineConfig, deleteConfigSurface, onLifecycle, onMessage, publishConfigSurface, spawnSlot, stopSlot } from '../../system/index.ts'
import { RouteRegistrationTopic } from '../../types/routes.ts'
import { UiSurfaceRegistrationTopic, type UiSurfaceRegistration } from '../../types/ui-surface.ts'
import { AgentRegistrationTopic, type AgentDescriptor } from '../../types/agents.ts'
import { LlmProviderTopic, type LlmProviderMsg } from '../../types/llm.ts'
import { OutboundUserMessageTopic } from '../../types/events.ts'
import type { ToolMsg, ToolCollection } from '../../types/tools.ts'
import { WorkflowRunner } from './workflow-runner.ts'
import { WorkflowsAgentFactory } from './workflows-agent.ts'
import { WorkflowToolsActor, workflowControlTools } from './workflow-tools.ts'
import { buildWorkflowsRoutes, workflowsSchemas } from './routes.ts'
import type { WorkflowsConfig, WorkflowRunnerMsg, WorkflowRunnerConfig } from './types.ts'

const getWorkflowRunsDir = (workflowsDir: string): string => join(workflowsDir, 'runs')

type PluginMsg =
  | { type: 'config'; slice: WorkflowsConfig | undefined }
  | { type: '_llmProvider'; ref: ActorRef<LlmProviderMsg> | null }

type PluginState = {
  initialized: boolean
  gen: number
  config: WorkflowsConfig
  llmRef: ActorRef<LlmProviderMsg> | null
  runner: ActorSlot<WorkflowRunnerConfig>
  toolsRef: ActorRef<ToolMsg> | null
}

const defaultConfig: WorkflowsConfig = {
  workflowsDir: 'workspace/workflows',
  agent: {
    model: 'z-ai/glm-5.1',
    maxToolLoops: 10,
    toolFilter: { allow: ['switch_mode'] },
  },
}

const config = defineConfig<WorkflowsConfig>('workflows', defaultConfig, {
  schemas: workflowsSchemas,
})

const buildWorkflowsTools = (toolsRef: ActorRef<ToolMsg>): ToolCollection => {
  const tools: ToolCollection = {}
  for (const tool of workflowControlTools) {
    tools[tool.name] = { ...tool, ref: toolsRef }
  }
  return tools
}

const buildDescriptor = (
  cfg: WorkflowsConfig,
  runnerRef: ActorRef<WorkflowRunnerMsg>,
  toolsRef: ActorRef<ToolMsg>,
): AgentDescriptor => ({
  mode: 'workflows',
  displayName: 'Workflows',
  shortDesc: 'Design, save, inspect, and run workflows',
  factory: WorkflowsAgentFactory({
    model: cfg.agent.model,
    maxToolLoops: cfg.agent.maxToolLoops,
    workflowsDir: cfg.workflowsDir,
    toolFilter: cfg.agent.toolFilter,
    tools: buildWorkflowsTools(toolsRef),
  }),
  capabilities: { userVisible: true },
})

const publishRoutes = (
  ctx: ActorContext<PluginMsg>,
  runnerRef: ActorRef<WorkflowRunnerMsg>,
  workflowsDir: string,
  workflowRunsDir: string,
): void => {
  for (const reg of buildWorkflowsRoutes(workflowsDir, runnerRef, workflowRunsDir)) {
    ctx.publishRetained(RouteRegistrationTopic, reg.id, reg)
  }
}

const deleteRoutes = (
  ctx: ActorContext<PluginMsg>,
  runnerRef: ActorRef<WorkflowRunnerMsg> | null,
  workflowsDir: string,
  workflowRunsDir: string,
): void => {
  for (const reg of buildWorkflowsRoutes(workflowsDir, runnerRef, workflowRunsDir)) {
    ctx.deleteRetained(RouteRegistrationTopic, reg.id, {
      id: reg.id,
      method: reg.method,
      path: reg.path,
      match: reg.match,
      handler: null,
    })
  }
}

const workflowsSurfaceRegistration: UiSurfaceRegistration = {
  id: 'workflows',
  version: '1.0.0',
  window: {
    title: 'Workflows',
    icon: 'git-branch',
    contentTag: 'r-workflow-workspace',
    dockResizable: false,
    defaultWidth: 460,
    defaultHeight: 600,
    minWidth: 320,
    minHeight: 200,
    modes: ['workflows'],
  },
  moduleUrl: '/plugins/workflows/ui/index.js',
  frameTypes: ['workflowGraph', 'workflowRunUpdated'],
}

const publishSurface = (ctx: ActorContext<PluginMsg>): void => {
  ctx.publishRetained(UiSurfaceRegistrationTopic, 'workflows', workflowsSurfaceRegistration)
}

const deleteSurface = (ctx: ActorContext<PluginMsg>): void => {
  ctx.deleteRetained(UiSurfaceRegistrationTopic, 'workflows', {
    id: 'workflows',
    window: null,
    moduleUrl: null,
    frameTypes: null,
  })
}

const stopChildren = (state: PluginState, ctx: ActorContext<PluginMsg>): void => {
  stopSlot(ctx, state.runner)
  if (state.toolsRef) ctx.stop(state.toolsRef)
}

const spawnChildren = (
  ctx: ActorContext<PluginMsg>,
  cfg: WorkflowsConfig,
  llmRef: ActorRef<LlmProviderMsg> | null,
  state: PluginState,
  gen: number,
): Pick<PluginState, 'runner' | 'toolsRef'> => {
  const runner = spawnSlot(
    ctx,
    state.runner,
    'workflow-runner',
    WorkflowRunner,
    {
      workflowsDir: cfg.workflowsDir,
      workflowRunsDir: getWorkflowRunsDir(cfg.workflowsDir),
      llmRef,
      model: cfg.agent.model,
      maxToolLoops: cfg.agent.maxToolLoops ?? 10,
    },
  )
  const toolsRef = ctx.spawn(
    `workflows-tools-${gen}`,
    WorkflowToolsActor({
      workflowsDir: cfg.workflowsDir,
      workflowRunnerRef: runner.ref as ActorRef<WorkflowRunnerMsg>,
      publishGraph: (userId, workflowId, runId) => {
        ctx.publish(OutboundUserMessageTopic, {
          userId,
          text: JSON.stringify({ type: 'workflowGraph', workflowId, ...(runId ? { runId } : {}) }),
        })
      },
    }),
  ) as ActorRef<ToolMsg>

  ctx.publish(AgentRegistrationTopic, {
    type: 'register',
    descriptor: buildDescriptor(cfg, runner.ref as ActorRef<WorkflowRunnerMsg>, toolsRef),
  })
  return { runner, toolsRef }
}

const restart = (
  state: PluginState,
  ctx: ActorContext<PluginMsg>,
  cfg: WorkflowsConfig,
  llmRef: ActorRef<LlmProviderMsg> | null,
): PluginState => {
  deleteRoutes(ctx, state.runner.ref as ActorRef<WorkflowRunnerMsg> | null, state.config.workflowsDir, getWorkflowRunsDir(state.config.workflowsDir))
  deleteSurface(ctx)
  stopChildren(state, ctx)
  ctx.publish(AgentRegistrationTopic, { type: 'unregister', mode: 'workflows' })
  const gen = state.gen + 1
  const children = spawnChildren(ctx, cfg, llmRef, state, gen)
  publishRoutes(ctx, children.runner.ref as ActorRef<WorkflowRunnerMsg>, cfg.workflowsDir, getWorkflowRunsDir(cfg.workflowsDir))
  publishSurface(ctx)
  return { ...state, config: cfg, llmRef, gen, ...children }
}

const workflowsPlugin: PluginDef<PluginMsg, PluginState, WorkflowsConfig> = {
  id: 'workflows',
  version: '1.0.0',
  description: 'Workflows plugin: design and execute saved workflow DAGs',
  configDescriptor: config,
  initialState: {
    initialized: false,
    gen: 0,
    config: defaultConfig,
    llmRef: null,
    runner: createSlot<WorkflowRunnerConfig>(),
    toolsRef: null,
  },
  lifecycle: onLifecycle({
    start: (state, ctx) => {
      const cfg = { ...defaultConfig, ...(ctx.initialConfig() as WorkflowsConfig | undefined ?? {}) }
      ctx.subscribe(LlmProviderTopic, event => ({ type: '_llmProvider' as const, ref: event.ref }))
      publishConfigSurface(ctx, config, () => cfg)
      const children = spawnChildren(ctx, cfg, state.llmRef, state, 0)
      publishRoutes(ctx, children.runner.ref as ActorRef<WorkflowRunnerMsg>, cfg.workflowsDir, getWorkflowRunsDir(cfg.workflowsDir))
      publishSurface(ctx)
      ctx.log.info('workflows plugin activated', { workflowsDir: cfg.workflowsDir, workflowRunsDir: getWorkflowRunsDir(cfg.workflowsDir) })
      return { state: { ...state, initialized: true, config: cfg, llmRef: state.llmRef, ...children } }
    },
    stopped: (state, ctx) => {
      deleteRoutes(ctx, state.runner.ref as ActorRef<WorkflowRunnerMsg> | null, state.config.workflowsDir, getWorkflowRunsDir(state.config.workflowsDir))
      deleteSurface(ctx)
      stopChildren(state, ctx)
      ctx.publish(AgentRegistrationTopic, { type: 'unregister', mode: 'workflows' })
      deleteConfigSurface(ctx, config)
      ctx.log.info('workflows plugin deactivated')
      return { state }
    },
  }),
  handler: onMessage<PluginMsg, PluginState>({
    _llmProvider: (state, msg, ctx) => {
      if (!state.initialized) return { state: { ...state, llmRef: msg.ref } }
      const next = restart(state, ctx, state.config, msg.ref)
      return { state: { ...next, llmRef: msg.ref } }
    },
    config: (state, msg, ctx) => {
      const cfg = { ...defaultConfig, ...(msg.slice ?? {}) }
      const next = restart(state, ctx, cfg, state.llmRef)
      return { state: { ...next, initialized: true, config: cfg } }
    },
  }),
}

export default workflowsPlugin