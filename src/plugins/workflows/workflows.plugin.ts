import { createPluginFactory } from '../../system/index.ts'
import type { ActorRef } from '../../system/index.ts'
import { RouteRegistrationTopic } from '../../types/routes.ts'
import { type UiSurfaceRegistration } from '../../types/ui-surface.ts'
import type { ToolMsg, ToolCollection } from '../../types/tools.ts'
import { WorkflowRunner } from './workflow-runner.ts'
import { WorkflowManager } from './workflow-manager.ts'
import { WorkflowsAgentDescriptor } from './workflows-agent.ts'
import { WorkflowToolsActor, workflowControlTools } from './workflow-tools.ts'
import { buildWorkflowsRoutes } from './workflows.routes.ts'
import { config, defaultConfig, type WorkflowsConfig } from './workflows.config.ts'
import type { WorkflowRunnerMsg } from './types.ts'
import { OperatorSpawner } from './operator-spawner.ts'

const buildWorkflowsTools = (toolsRef: ActorRef<ToolMsg>): ToolCollection => {
  const tools: ToolCollection = {}
  for (const tool of workflowControlTools) {
    tools[tool.name] = { ...tool, ref: toolsRef }
  }
  return tools
}

const workflowsSurfaceRegistration: UiSurfaceRegistration = {
  id: 'workflows',
  version: '1.0.0',
  view: {
    title: 'Workflows',
    icon: 'git-branch',
    contentTag: 'r-workflow-workspace',
    modes: ['workflows'],
  },
  moduleUrl: '/js/plugins/workflows.js',
  frameTypes: ['workflow.graph', 'workflow.run.updated', 'workflows.list', 'workflow.runs.list', 'workflow.error', 'workflow.delete', 'workflow.run.delete'],
}

export default createPluginFactory<WorkflowsConfig>({
  id: 'workflows',
  version: '1.0.0',
  description: 'Workflows plugin: design and execute saved workflow DAGs',
  configDescriptor: config,
  slots: {
    runner: {
      factory: (cfg) => {
        return WorkflowRunner({
          llmRef: null,
          model: cfg.agent.model,
          maxToolLoops: cfg.agent.maxToolLoops ?? 10,
        })
      },
    },
    manager: {
      factory: (cfg) => {
        return WorkflowManager({
          model: cfg.agent.model,
          maxToolLoops: cfg.agent.maxToolLoops ?? 10,
        })
      },
    },
    tools: {
      factory: (_cfg, deps) => WorkflowToolsActor({
        workflowRunnerRef: deps.runner as ActorRef<WorkflowRunnerMsg>,
      }),
      dependsOn: ['runner'],
    },
    operatorSpawner: {
      factory: () => OperatorSpawner(),
    },
  },

  agents: {
    workflows: {
      factory: WorkflowsAgentDescriptor,
      options: (cfg, deps) => ({
        model: cfg.agent.model,
        maxToolLoops: cfg.agent.maxToolLoops,
        toolFilter: cfg.agent.toolFilter,
        tools: buildWorkflowsTools(deps.tools as ActorRef<ToolMsg>),
      }),
      dependsOn: ['tools'],
    },
  },
  routes: (cfg, deps) => {
    return buildWorkflowsRoutes(deps.runner as ActorRef<WorkflowRunnerMsg> | null)
  },
  uiSurface: workflowsSurfaceRegistration,
})
