import type { ActorContext, ActorRef, PluginDef } from '../../system/index.ts'
import { defineConfig, deleteConfigSurface, onLifecycle, onMessage, publishConfigSurface } from '../../system/index.ts'
import { RouteRegistrationTopic } from '../../types/routes.ts'
import { AgentRegistrationTopic, type AgentDescriptor } from '../../types/agents.ts'
import { LlmProviderTopic, type LlmProviderMsg } from '../../types/llm.ts'
import { WorkflowStore } from './workflow-store.ts'
import { WorkflowRunner } from './workflow-runner.ts'
import { WorkflowTools, workflowControlTools } from './tools.ts'
import { WorkflowsAgentFactory } from './workflows-agent.ts'
import { buildWorkflowsRoutes, workflowsSchemas } from './routes.ts'
import type { WorkflowsConfig, WorkflowRunnerMsg, WorkflowStoreMsg, WorkflowToolsMsg } from './types.ts'

type PluginMsg =
  | { type: 'config'; slice: WorkflowsConfig | undefined }
  | { type: '_llmProvider'; ref: ActorRef<LlmProviderMsg> | null }

type PluginState = {
  initialized: boolean
  gen: number
  config: WorkflowsConfig
  llmRef: ActorRef<LlmProviderMsg> | null
  storeRef: ActorRef<WorkflowStoreMsg> | null
  runnerRef: ActorRef<WorkflowRunnerMsg> | null
  toolsRef: ActorRef<WorkflowToolsMsg> | null
}

const defaultConfig: WorkflowsConfig = {
  workflowsDir: 'workspace/workflows',
  workflowRunsDir: 'workspace/workflows/runs',
  workflows: {
    model: 'z-ai/glm-5.1',
    maxToolLoops: 10,
  },
}

const config = defineConfig<WorkflowsConfig>('workflows', defaultConfig, {
  schemas: workflowsSchemas,
})

const buildDescriptor = (
  cfg: WorkflowsConfig,
  toolsRef: ActorRef<WorkflowToolsMsg>,
): AgentDescriptor => ({
  mode: 'workflows',
  displayName: 'Workflows',
  shortDesc: 'Design, save, inspect, and run workflows',
  factory: WorkflowsAgentFactory({
    model: cfg.workflows.model,
    maxToolLoops: cfg.workflows.maxToolLoops,
    workflowToolsRef: toolsRef,
  }),
  capabilities: { userVisible: true },
})

const publishRoutes = (
  ctx: ActorContext<PluginMsg>,
  storeRef: ActorRef<WorkflowStoreMsg> | null,
  runnerRef: ActorRef<WorkflowRunnerMsg> | null,
): void => {
  for (const reg of buildWorkflowsRoutes(storeRef, runnerRef)) {
    ctx.publishRetained(RouteRegistrationTopic, reg.id, reg)
  }
}

const deleteRoutes = (
  ctx: ActorContext<PluginMsg>,
  storeRef: ActorRef<WorkflowStoreMsg> | null,
  runnerRef: ActorRef<WorkflowRunnerMsg> | null,
): void => {
  for (const reg of buildWorkflowsRoutes(storeRef, runnerRef)) {
    ctx.deleteRetained(RouteRegistrationTopic, reg.id, {
      id: reg.id,
      method: reg.method,
      path: reg.path,
      match: reg.match,
      handler: null,
    })
  }
}

const stopChildren = (state: PluginState, ctx: ActorContext<PluginMsg>): void => {
  if (state.toolsRef) ctx.stop(state.toolsRef)
  if (state.runnerRef) ctx.stop(state.runnerRef)
  if (state.storeRef) ctx.stop(state.storeRef)
}

const spawnChildren = (
  ctx: ActorContext<PluginMsg>,
  cfg: WorkflowsConfig,
  llmRef: ActorRef<LlmProviderMsg> | null,
  gen: number,
): Pick<PluginState, 'storeRef' | 'runnerRef' | 'toolsRef'> => {
  const storeRef = ctx.spawn(`workflow-store-${gen}`, WorkflowStore(cfg.workflowsDir)) as ActorRef<WorkflowStoreMsg>
  const runnerRef = ctx.spawn(
    `workflow-runner-${gen}`,
    WorkflowRunner(storeRef, cfg.workflowRunsDir, llmRef, cfg.workflows.model, cfg.workflows.maxToolLoops),
  ) as ActorRef<WorkflowRunnerMsg>
  const toolsRef = ctx.spawn(`workflow-tools-${gen}`, WorkflowTools(storeRef, runnerRef)) as ActorRef<WorkflowToolsMsg>

  ctx.publish(AgentRegistrationTopic, { type: 'register', descriptor: buildDescriptor(cfg, toolsRef) })
  return { storeRef, runnerRef, toolsRef }
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
    storeRef: null,
    runnerRef: null,
    toolsRef: null,
  },
  lifecycle: onLifecycle({
    start: (state, ctx) => {
      const cfg = { ...defaultConfig, ...(ctx.initialConfig() as WorkflowsConfig | undefined ?? {}) }
      ctx.subscribe(LlmProviderTopic, event => ({ type: '_llmProvider' as const, ref: event.ref }))
      publishConfigSurface(ctx, config, () => cfg)
      const children = spawnChildren(ctx, cfg, state.llmRef, 0)
      publishRoutes(ctx, children.storeRef, children.runnerRef)
      for (const tool of workflowControlTools) {
        ctx.log.debug('workflows control tool configured', { tool: tool.name })
      }
      ctx.log.info('workflows plugin activated', { workflowsDir: cfg.workflowsDir, workflowRunsDir: cfg.workflowRunsDir })
      return { state: { initialized: true, gen: 0, config: cfg, llmRef: state.llmRef, ...children } }
    },
    stopped: (state, ctx) => {
      deleteRoutes(ctx, state.storeRef, state.runnerRef)
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
      deleteRoutes(ctx, state.storeRef, state.runnerRef)
      stopChildren(state, ctx)
      ctx.publish(AgentRegistrationTopic, { type: 'unregister', mode: 'workflows' })
      const gen = state.gen + 1
      const children = spawnChildren(ctx, state.config, msg.ref, gen)
      publishRoutes(ctx, children.storeRef, children.runnerRef)
      return { state: { ...state, gen, llmRef: msg.ref, ...children } }
    },
    config: (state, msg, ctx) => {
      deleteRoutes(ctx, state.storeRef, state.runnerRef)
      stopChildren(state, ctx)
      ctx.publish(AgentRegistrationTopic, { type: 'unregister', mode: 'workflows' })
      const cfg = { ...defaultConfig, ...(msg.slice ?? {}) }
      const gen = state.gen + 1
      const children = spawnChildren(ctx, cfg, state.llmRef, gen)
      publishRoutes(ctx, children.storeRef, children.runnerRef)
      return { state: { ...state, initialized: true, gen, config: cfg, ...children } }
    },
  }),
}

export default workflowsPlugin
