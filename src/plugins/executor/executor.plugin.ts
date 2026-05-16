import type { ActorContext, ActorRef, PluginDef } from '../../system/types.ts'
import { defineConfig, publishConfigSurface, deleteConfigSurface } from '../../system/plugin-config.ts'
import { onLifecycle, onMessage } from '../../system/match.ts'
import { RouteRegistrationTopic } from '../../types/routes.ts'
import { IdentityProviderTopic } from '../../types/identity.ts'
import type { IdentityProviderMsg } from '../../types/identity.ts'
import type { ToolCollection, ToolMsg } from '../../types/tools.ts'
import { AgentRegistrationTopic, type AgentDescriptor } from '../cognitive/types.ts'
import { ExecutorAgentFactory } from './executor-agent.ts'
import { PlanStore } from './plan-store.ts'
import { ExecutorTools, getPlanTool, listPlansTool, showPlanGraphTool } from './tools.ts'
import { buildExecutorRoutes, executorSchemas } from './routes.ts'
import type { ExecutorConfig, ExecutorToolsMsg, PlanStoreMsg } from './types.ts'

type PluginMsg =
  | { type: 'config'; slice: ExecutorConfig | undefined }
  | { type: '_identityProvider'; ref: ActorRef<IdentityProviderMsg> | null }

type PluginState = {
  initialized: boolean
  gen: number
  plansDir: string
  model: string
  maxToolLoops: number
  planStoreRef: ActorRef<PlanStoreMsg> | null
  toolsRef: ActorRef<ExecutorToolsMsg> | null
  identityProviderRef: ActorRef<IdentityProviderMsg> | null
}

const defaultConfig: ExecutorConfig = {
  plansDir:     'workspace/plans',
  model:        'z-ai/glm-5.1',
  maxToolLoops: 10,
}

const config = defineConfig<ExecutorConfig>('executor', defaultConfig, {
  schemas: executorSchemas,
})

const buildTools = (toolsRef: ActorRef<ExecutorToolsMsg>): ToolCollection => {
  const ref = toolsRef as unknown as ActorRef<ToolMsg>
  return {
    [listPlansTool.name]:     { ...listPlansTool, ref },
    [getPlanTool.name]:       { ...getPlanTool, ref },
    [showPlanGraphTool.name]: { ...showPlanGraphTool, ref },
  }
}

const buildDescriptor = (
  cfg: Pick<PluginState, 'model' | 'maxToolLoops'>,
  toolsRef: ActorRef<ExecutorToolsMsg>,
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

const publishRoutes = (
  ctx: ActorContext<PluginMsg>,
  identityProviderRef: ActorRef<IdentityProviderMsg> | null,
  planStoreRef: ActorRef<PlanStoreMsg> | null,
): void => {
  for (const reg of buildExecutorRoutes(identityProviderRef, planStoreRef)) {
    ctx.publishRetained(RouteRegistrationTopic, reg.id, reg)
  }
}

const deleteRoutes = (
  ctx: ActorContext<PluginMsg>,
  identityProviderRef: ActorRef<IdentityProviderMsg> | null,
  planStoreRef: ActorRef<PlanStoreMsg> | null,
): void => {
  for (const reg of buildExecutorRoutes(identityProviderRef, planStoreRef)) {
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
  cfg: ExecutorConfig,
  gen: number,
): Pick<PluginState, 'planStoreRef' | 'toolsRef'> => {
  const planStoreRef = ctx.spawn(`plan-store-${gen}`, PlanStore(cfg.plansDir)) as ActorRef<PlanStoreMsg>
  const toolsRef = ctx.spawn(`executor-tools-${gen}`, ExecutorTools(planStoreRef)) as ActorRef<ExecutorToolsMsg>
  ctx.publish(AgentRegistrationTopic, { type: 'register', descriptor: buildDescriptor(cfg, toolsRef) })
  return { planStoreRef, toolsRef }
}

const executorPlugin: PluginDef<PluginMsg, PluginState, ExecutorConfig> = {
  id:          'executor',
  version:     '1.0.0',
  description: 'Read-only plan executor: inspect saved plans and render task DAGs',

  configDescriptor: config,

  initialState: {
    initialized:         false,
    gen:                 0,
    plansDir:            defaultConfig.plansDir,
    model:               defaultConfig.model,
    maxToolLoops:        defaultConfig.maxToolLoops,
    planStoreRef:        null,
    toolsRef:            null,
    identityProviderRef: null,
  },

  lifecycle: onLifecycle({
    start: (_state, ctx) => {
      const cfg = { ...defaultConfig, ...(ctx.initialConfig() as ExecutorConfig | undefined ?? {}) }

      publishConfigSurface(ctx, config, () => cfg)

      ctx.subscribe(IdentityProviderTopic, (e) => ({ type: '_identityProvider' as const, ref: e.ref }))
      const children = spawnChildren(ctx, cfg, 0)
      publishRoutes(ctx, null, children.planStoreRef)

      ctx.log.info('executor plugin activated', { plansDir: cfg.plansDir })
      return { state: { initialized: true, gen: 0, ...cfg, ...children, identityProviderRef: null } }
    },

    stopped: (state, ctx) => {
      deleteRoutes(ctx, state.identityProviderRef, state.planStoreRef)
      stopChildren(state, ctx)
      ctx.publish(AgentRegistrationTopic, { type: 'unregister', mode: 'executor' })
      deleteConfigSurface(ctx, config)
      ctx.log.info('executor plugin deactivated')
      return { state }
    },
  }),

  handler: onMessage<PluginMsg, PluginState>({
    _identityProvider: (state, msg, ctx) => {
      deleteRoutes(ctx, state.identityProviderRef, state.planStoreRef)
      publishRoutes(ctx, msg.ref, state.planStoreRef)
      return { state: { ...state, identityProviderRef: msg.ref } }
    },

    config: (state, msg, ctx) => {
      deleteRoutes(ctx, state.identityProviderRef, state.planStoreRef)
      stopChildren(state, ctx)
      ctx.publish(AgentRegistrationTopic, { type: 'unregister', mode: 'executor' })

      const cfg = { ...defaultConfig, ...(msg.slice ?? {}) }
      const gen = state.gen + 1
      const children = spawnChildren(ctx, cfg, gen)
      publishRoutes(ctx, state.identityProviderRef, children.planStoreRef)

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

export default executorPlugin
