import { createPluginFactory } from '../../system/index.ts'
import type { ActorRef } from '../../system/index.ts'
import { RouteRegistrationTopic } from '../../types/routes.ts'
import { type UiSurfaceRegistration } from '../../types/ui-surface.ts'
import type { ToolMsg, ToolCollection } from '../../types/tools.ts'
import { WorkflowManager } from './workflow-manager.ts'
import { WorkflowsAgentDescriptor } from './workflows-agent.ts'
import {
  WorkflowToolsActor,
  listAgentModesTool,
  listExecutionToolsTool,
  saveWorkflowTool,
  updateWorkflowTool,
  deleteWorkflowTool,
  listWorkflowsTool,
  getWorkflowTool,
  showWorkflowGraphTool,
  startWorkflowRunTool,
  listWorkflowRunsTool,
  getWorkflowRunTool,
  resumeWorkflowRunTool,
} from './workflow-tools.ts'
import { buildWorkflowsRoutes } from './workflows.routes.ts'
import { config, defaultConfig, type WorkflowsConfig } from './workflows.config.ts'
import { OperatorSpawner } from './operator-spawner.ts'

const workflowsControlToolsList = [
  listAgentModesTool,
  listExecutionToolsTool,
  saveWorkflowTool,
  updateWorkflowTool,
  deleteWorkflowTool,
  listWorkflowsTool,
  getWorkflowTool,
  showWorkflowGraphTool,
  startWorkflowRunTool,
  listWorkflowRunsTool,
  getWorkflowRunTool,
  resumeWorkflowRunTool,
]

const buildWorkflowsTools = (toolsRef: ActorRef<ToolMsg>): ToolCollection => {
  const tools: ToolCollection = {}
  for (const tool of workflowsControlToolsList) {
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
        workflowRunnerRef: deps.manager as ActorRef<any>,
      }),
      dependsOn: ['manager'],
    },
    operatorSpawner: {
      factory: () => OperatorSpawner(),
    },
  },
  tools: {
    agentModesList: { schema: listAgentModesTool.schema, slot: 'tools' },
    executionToolsList: { schema: listExecutionToolsTool.schema, slot: 'tools' },
    save: { schema: saveWorkflowTool.schema, slot: 'tools' },
    update: { schema: updateWorkflowTool.schema, slot: 'tools' },
    delete: { schema: deleteWorkflowTool.schema, slot: 'tools' },
    list: { schema: listWorkflowsTool.schema, slot: 'tools' },
    get: { schema: getWorkflowTool.schema, slot: 'tools' },
    graphShow: { schema: showWorkflowGraphTool.schema, slot: 'tools' },
    runStart: { schema: startWorkflowRunTool.schema, slot: 'tools' },
    runsList: { schema: listWorkflowRunsTool.schema, slot: 'tools' },
    runGet: { schema: getWorkflowRunTool.schema, slot: 'tools' },
    runResume: { schema: resumeWorkflowRunTool.schema, slot: 'tools' },
  },

  agents: {
    workflows: {
      slot: 'manager',
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
    return buildWorkflowsRoutes(deps.manager as ActorRef<any>)
  },
  uiSurface: workflowsSurfaceRegistration,
})
