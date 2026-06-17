import type { ActorContext, ActorRef, ActorSlot, PluginDef } from '../../system/index.ts'
import { createSlot, defineConfig, deleteConfigSurface, onLifecycle, onMessage, publishConfigSurface, spawnSlot, stopSlot } from '../../system/index.ts'
import { RouteRegistrationTopic } from '../../types/routes.ts'
import { AgentRegistrationTopic, type AgentDescriptor } from '../../types/agents.ts'
import { LlmProviderTopic, type LlmProviderMsg } from '../../types/llm.ts'
import { WorkflowStore } from './workflow-store.ts'
import { WorkflowRunner } from './workflow-runner.ts'
import { WorkflowsAgentFactory } from './workflows-agent.ts'
import { buildWorkflowsRoutes, workflowsSchemas } from './routes.ts'
import type { WorkflowsConfig, WorkflowRunnerMsg, WorkflowStoreMsg } from './types.ts'
import type { ToolFilter } from '../../types/tools.ts'

type PluginMsg =
  | { type: 'config'; slice: WorkflowsConfig | undefined }
  | { type: '_llmProvider'; ref: ActorRef<LlmProviderMsg> | null }

type PluginState = {
  initialized: boolean
  config: WorkflowsConfig
  llmRef: ActorRef<LlmProviderMsg> | null
  store: ActorSlot<null>
  runner: ActorSlot<null>
}

const defaultConfig: WorkflowsConfig = {
  workflowsDir: 'workspace/workflows',
  workflowRunsDir: 'workspace/workflows/runs',
  agent: {
    model: 'z-ai/glm-5.1',
    maxToolLoops: 10,
    toolFilter: { allow: ['switch_mode'] },
  },
}

const config = defineConfig<WorkflowsConfig>('workflows', defaultConfig, {
  schemas: workflowsSchemas,
})

const buildDescriptor = (
  cfg: WorkflowsConfig,
  storeRef: ActorRef<WorkflowStoreMsg>,
  runnerRef: ActorRef<WorkflowRunnerMsg>,
): AgentDescriptor => ({
  mode: 'workflows',
  displayName: 'Workflows',
  shortDesc: 'Design, save, inspect, and run workflows',
  factory: WorkflowsAgentFactory({
    model: cfg.agent.model,
    maxToolLoops: cfg.agent.maxToolLoops,
    workflowStoreRef: storeRef,
    workflowRunnerRef: runnerRef,
    toolFilter: cfg.agent.toolFilter,
  }),
  capabilities: { userVisible: true },
})

const publishRoutes = (
  ctx: ActorContext<PluginMsg>,
  storeRef: ActorRef<WorkflowStoreMsg>,
  runnerRef: ActorRef<WorkflowRunnerMsg>,
  workflowRunsDir: string,
): void => {
  for (const reg of buildWorkflowsRoutes(storeRef, runnerRef, workflowRunsDir)) {
    ctx.publishRetained(RouteRegistrationTopic, reg.id, reg)
  }
}

const deleteRoutes = (
  ctx: ActorContext<PluginMsg>,
  storeRef: ActorRef<WorkflowStoreMsg> | null,
  runnerRef: ActorRef<WorkflowRunnerMsg> | null,
  workflowRunsDir: string,
): void => {
  for (const reg of buildWorkflowsRoutes(storeRef, runnerRef, workflowRunsDir)) {
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
  stopSlot(ctx, state.runner)
  stopSlot(ctx, state.store)
}

const spawnChildren = (
  ctx: ActorContext<PluginMsg>,
  cfg: WorkflowsConfig,
  llmRef: ActorRef<LlmProviderMsg> | null,
  state: PluginState,
): Pick<PluginState, 'store' | 'runner'> => {
  const store = spawnSlot(ctx, state.store, 'workflow-store', () => WorkflowStore(cfg.workflowsDir), null)
  const runner = spawnSlot(
    ctx,
    state.runner,
    'workflow-runner',
    () => WorkflowRunner(store.ref as ActorRef<WorkflowStoreMsg>, cfg.workflowRunsDir, llmRef, cfg.agent.model, cfg.agent.maxToolLoops),
    null,
  )
  ctx.publish(AgentRegistrationTopic, {
    type: 'register',
    descriptor: buildDescriptor(cfg, store.ref as ActorRef<WorkflowStoreMsg>, runner.ref as ActorRef<WorkflowRunnerMsg>),
  })
  return { store, runner }
}

const restart = (
  state: PluginState,
  ctx: ActorContext<PluginMsg>,
  cfg: WorkflowsConfig,
  llmRef: ActorRef<LlmProviderMsg> | null,
): PluginState => {
  deleteRoutes(ctx, state.store.ref as ActorRef<WorkflowStoreMsg> | null, state.runner.ref as ActorRef<WorkflowRunnerMsg> | null, state.config.workflowRunsDir)
  stopChildren(state, ctx)
  ctx.publish(AgentRegistrationTopic, { type: 'unregister', mode: 'workflows' })
  const children = spawnChildren(ctx, cfg, llmRef, state)
  publishRoutes(ctx, children.store.ref as ActorRef<WorkflowStoreMsg>, children.runner.ref as ActorRef<WorkflowRunnerMsg>, cfg.workflowRunsDir)
  return { ...state, config: cfg, llmRef, ...children }
}

const workflowsPlugin: PluginDef<PluginMsg, PluginState, WorkflowsConfig> = {
  id: 'workflows',
  version: '1.0.0',
  description: 'Workflows plugin: design and execute saved workflow DAGs',
  configDescriptor: config,
  initialState: {
    initialized: false,
    config: defaultConfig,
    llmRef: null,
    store: createSlot<null>(),
    runner: createSlot<null>(),
  },
  lifecycle: onLifecycle({
    start: (state, ctx) => {
      const cfg = { ...defaultConfig, ...(ctx.initialConfig() as WorkflowsConfig | undefined ?? {}) }
      ctx.subscribe(LlmProviderTopic, event => ({ type: '_llmProvider' as const, ref: event.ref }))
      publishConfigSurface(ctx, config, () => cfg)
      const children = spawnChildren(ctx, cfg, state.llmRef, state)
      publishRoutes(ctx, children.store.ref as ActorRef<WorkflowStoreMsg>, children.runner.ref as ActorRef<WorkflowRunnerMsg>, cfg.workflowRunsDir)
      ctx.log.info('workflows plugin activated', { workflowsDir: cfg.workflowsDir, workflowRunsDir: cfg.workflowRunsDir })
      return { state: { initialized: true, config: cfg, llmRef: state.llmRef, ...children } }
    },
    stopped: (state, ctx) => {
      deleteRoutes(ctx, state.store.ref as ActorRef<WorkflowStoreMsg> | null, state.runner.ref as ActorRef<WorkflowRunnerMsg> | null, state.config.workflowRunsDir)
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
