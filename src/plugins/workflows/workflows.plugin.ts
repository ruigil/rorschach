import type { ActorContext, ActorRef, PluginDef } from '../../system/types.ts'
import { defineConfig, publishConfigSurface, deleteConfigSurface } from '../../system/plugin-config.ts'
import { onLifecycle, onMessage } from '../../system/match.ts'
import { RouteRegistrationTopic } from '../../types/routes.ts'
import type { ToolCollection, ToolMsg, ToolFilter } from '../../types/tools.ts'
import { AgentRegistrationTopic, type AgentDescriptor } from '../../types/agents.ts'
import { ExecutorAgentFactory } from './executor-agent.ts'
import { PlannerAgentFactory } from './planner-agent.ts'
import { PlanStore } from './plan-store.ts'
import { WorkflowTools, getPlanTool, listPlansTool, showPlanGraphTool } from './tools.ts'
import { buildWorkflowsRoutes, workflowsSchemas } from './routes.ts'
import type { WorkflowsConfig, WorkflowToolsMsg, PlanStoreMsg } from './types.ts'

type PluginMsg =
  | { type: 'config'; slice: WorkflowsConfig | undefined }

type PluginState = {
  initialized: boolean
  gen: number
  plansDir: string
  executor: {
    model: string
    maxToolLoops: number
  }
  planner: {
    model: string
    maxToolLoops: number
    toolFilter?: ToolFilter
  }
  planStoreRef: ActorRef<PlanStoreMsg> | null
  toolsRef: ActorRef<WorkflowToolsMsg> | null
}

const defaultConfig: WorkflowsConfig = {
  plansDir:     'workspace/plans',
  executor: {
    model:        'z-ai/glm-5.1',
    maxToolLoops: 10,
  },
  planner: {
    model:        'z-ai/glm-5.1',
    maxToolLoops: 10,
    toolFilter: {
      allow: [
        'web_search',
        'fetch_file',
        'switch_mode',
      ],
    },
  },
}

const config = defineConfig<WorkflowsConfig>('workflows', defaultConfig, {
  schemas: workflowsSchemas,
})

const buildTools = (toolsRef: ActorRef<WorkflowToolsMsg>): ToolCollection => {
  const ref = toolsRef as unknown as ActorRef<ToolMsg>
  return {
    [listPlansTool.name]:     { ...listPlansTool, ref },
    [getPlanTool.name]:       { ...getPlanTool, ref },
    [showPlanGraphTool.name]: { ...showPlanGraphTool, ref },
  }
}

const buildExecutorDescriptor = (
  cfg: { model: string; maxToolLoops: number },
  toolsRef: ActorRef<WorkflowToolsMsg>,
): AgentDescriptor => ({
  mode:        'executor',
  displayName: 'Executor',
  shortDesc:   'Inspect saved plans and show task dependency graphs',
  factory:     ExecutorAgentFactory({
    model:        cfg.model,
    maxToolLoops: cfg.maxToolLoops,
    tools:        buildTools(toolsRef),
  }),
  capabilities: { userVisible: true },
})

const buildPlannerDescriptor = (
  cfg: { model: string; maxToolLoops: number; toolFilter?: ToolFilter },
  plansDir: string,
  toolsRef: ActorRef<WorkflowToolsMsg>,
): AgentDescriptor => ({
  mode:        'planner',
  displayName: 'Planner',
  shortDesc:   'Structured planning of multi-step goals',
  factory:     PlannerAgentFactory({
    model:        cfg.model,
    maxToolLoops: cfg.maxToolLoops,
    toolFilter:   cfg.toolFilter,
    plansDir,
    workflowToolsRef: toolsRef,
  }),
  capabilities: { userVisible: true },
})

const publishRoutes = (
  ctx: ActorContext<PluginMsg>,
  planStoreRef: ActorRef<PlanStoreMsg> | null,
): void => {
  for (const reg of buildWorkflowsRoutes(planStoreRef)) {
    ctx.publishRetained(RouteRegistrationTopic, reg.id, reg)
  }
}

const deleteRoutes = (
  ctx: ActorContext<PluginMsg>,
  planStoreRef: ActorRef<PlanStoreMsg> | null,
): void => {
  for (const reg of buildWorkflowsRoutes(planStoreRef)) {
    ctx.deleteRetained(RouteRegistrationTopic, reg.id, {
      id:      reg.id,
      method:  reg.method,
      path:    reg.path,
      match:   reg.match,
      handler: null,
    })
  }
}

const stopChildren = (state: PluginState, ctx: ActorContext<PluginMsg>): void => {
  if (state.toolsRef) ctx.stop(state.toolsRef)
  if (state.planStoreRef) ctx.stop(state.planStoreRef)
}

const spawnChildren = (
  ctx: ActorContext<PluginMsg>,
  cfg: WorkflowsConfig,
  gen: number,
): Pick<PluginState, 'planStoreRef' | 'toolsRef'> => {
  const planStoreRef = ctx.spawn(`plan-store-${gen}`, PlanStore(cfg.plansDir)) as ActorRef<PlanStoreMsg>
  const toolsRef = ctx.spawn(`workflow-tools-${gen}`, WorkflowTools(planStoreRef, cfg.plansDir)) as ActorRef<WorkflowToolsMsg>
  
  ctx.publish(AgentRegistrationTopic, { type: 'register', descriptor: buildExecutorDescriptor(cfg.executor, toolsRef) })
  ctx.publish(AgentRegistrationTopic, { type: 'register', descriptor: buildPlannerDescriptor(cfg.planner, cfg.plansDir, toolsRef) })
  
  return { planStoreRef, toolsRef }
}

const workflowsPlugin: PluginDef<PluginMsg, PluginState, WorkflowsConfig> = {
  id:          'workflows',
  version:     '1.0.0',
  description: 'Workflows plugin: design plans conversationally or inspect their task dependency graphs',

  configDescriptor: config,

  initialState: {
    initialized:         false,
    gen:                 0,
    plansDir:            defaultConfig.plansDir,
    executor:            defaultConfig.executor,
    planner:             defaultConfig.planner,
    planStoreRef:        null,
    toolsRef:            null,
  },

  lifecycle: onLifecycle({
    start: (_state, ctx) => {
      const cfg = { ...defaultConfig, ...(ctx.initialConfig() as WorkflowsConfig | undefined ?? {}) }

      publishConfigSurface(ctx, config, () => cfg)

      const children = spawnChildren(ctx, cfg, 0)
      publishRoutes(ctx, children.planStoreRef)

      ctx.log.info('workflows plugin activated', { plansDir: cfg.plansDir })
      return { state: { initialized: true, gen: 0, ...cfg, ...children } }
    },

    stopped: (state, ctx) => {
      deleteRoutes(ctx, state.planStoreRef)
      stopChildren(state, ctx)
      ctx.publish(AgentRegistrationTopic, { type: 'unregister', mode: 'executor' })
      ctx.publish(AgentRegistrationTopic, { type: 'unregister', mode: 'planner' })
      deleteConfigSurface(ctx, config)
      ctx.log.info('workflows plugin deactivated')
      return { state }
    },
  }),

  handler: onMessage<PluginMsg, PluginState>({
    config: (state, msg, ctx) => {
      deleteRoutes(ctx, state.planStoreRef)
      stopChildren(state, ctx)
      ctx.publish(AgentRegistrationTopic, { type: 'unregister', mode: 'executor' })
      ctx.publish(AgentRegistrationTopic, { type: 'unregister', mode: 'planner' })

      const cfg = { ...defaultConfig, ...(msg.slice ?? {}) }
      const gen = state.gen + 1
      const children = spawnChildren(ctx, cfg, gen)
      publishRoutes(ctx, children.planStoreRef)

      return {
        state: {
          ...state,
          initialized: true,
          gen,
          ...cfg,
          ...children,
        },
      }
    },
  }),
}

export default workflowsPlugin
