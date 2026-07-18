import { createPluginFactory, defineConfig } from '../../system/index.ts'
import type { ActorRef } from '../../system/index.ts'
import { RouteRegistrationTopic } from '../../types/routes.ts'
import { type UiSurfaceRegistration } from '../../types/ui-surface.ts'
import type { ToolMsg, ToolCollection } from '../../types/tools.ts'
import { WorkflowRunner } from './workflow-runner.ts'
import { WorkflowsAgentDescriptor } from './workflows-agent.ts'
import { WorkflowToolsActor, workflowControlTools, readWorkflowArtifactTool, writeWorkflowArtifactTool } from './workflow-tools.ts'
import { buildWorkflowsRoutes, workflowsSchemas } from './routes.ts'
import type { WorkflowsConfig, WorkflowRunnerMsg } from './types.ts'

const defaultConfig: WorkflowsConfig = {
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
  frameTypes: ['workflow.graph', 'workflow.run.updated', 'workflows.list', 'workflow.runs.list', 'workflow.error'],
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
    tools: {
      factory: (_cfg, deps) => WorkflowToolsActor({
        workflowRunnerRef: deps.runner as ActorRef<WorkflowRunnerMsg>,
      }),
      dependsOn: ['runner'],
    },
  },
  tools: {
    read_workflow_artifact: { schema: readWorkflowArtifactTool.schema, slot: 'tools' },
    write_workflow_artifact: { schema: writeWorkflowArtifactTool.schema, slot: 'tools' },
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
