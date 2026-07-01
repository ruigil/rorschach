import { join } from 'node:path'
import { createPluginFactory, defineConfig } from '../../system/index.ts'
import type { ActorRef } from '../../system/index.ts'
import { RouteRegistrationTopic } from '../../types/routes.ts'
import { UiSurfaceRegistrationTopic, type UiSurfaceRegistration } from '../../types/ui-surface.ts'
import { AgentRegistrationTopic } from '../../types/agents.ts'
import type { ToolMsg, ToolCollection } from '../../types/tools.ts'
import { WorkflowRunner } from './workflow-runner.ts'
import { WorkflowsAgentFactory } from './workflows-agent.ts'
import { WorkflowToolsActor, workflowControlTools } from './workflow-tools.ts'
import { buildWorkflowsRoutes, workflowsSchemas } from './routes.ts'
import type { WorkflowsConfig, WorkflowRunnerMsg } from './types.ts'

const getWorkflowRunsDir = (workflowsDir: string): string => join(workflowsDir, 'runs')

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

const workflowsSurfaceRegistration: UiSurfaceRegistration = {
  id: 'workflows',
  version: '1.0.0',
  view: {
    title: 'Workflows',
    icon: 'git-branch',
    contentTag: 'r-workflow-workspace',
    modes: ['workflows'],
  },
  moduleUrl: '/plugins/workflows/ui/index.js',
  frameTypes: ['workflowGraph', 'workflowRunUpdated', 'workflowsList', 'workflowRunsList', 'workflowError'],
}

export default createPluginFactory<WorkflowsConfig>({
  id: 'workflows',
  version: '1.0.0',
  description: 'Workflows plugin: design and execute saved workflow DAGs',
  configDescriptor: config,
  slots: {
    runner: {
      factory: (cfg) => {
        const workflowsDir = cfg.workflowsDir ?? 'workspace/workflows'
        return WorkflowRunner({
          workflowsDir,
          workflowRunsDir: getWorkflowRunsDir(workflowsDir),
          llmRef: null,
          model: cfg.agent.model,
          maxToolLoops: cfg.agent.maxToolLoops ?? 10,
        })
      },
    },
    tools: {
      factory: (cfg, deps) => WorkflowToolsActor({
        workflowsDir: cfg.workflowsDir ?? 'workspace/workflows',
        workflowRunnerRef: deps.runner as ActorRef<WorkflowRunnerMsg>,
      }),
      dependsOn: ['runner'],
    },
  },
  agents: {
    workflows: {
      factory: WorkflowsAgentFactory,
      options: (cfg, deps) => ({
        model: cfg.agent.model,
        maxToolLoops: cfg.agent.maxToolLoops,
        workflowsDir: cfg.workflowsDir ?? 'workspace/workflows',
        toolFilter: cfg.agent.toolFilter,
        tools: buildWorkflowsTools(deps.tools as ActorRef<ToolMsg>),
      }),
      dependsOn: ['tools'],
    },
  },
  routes: (cfg, deps) => {
    const workflowsDir = cfg.workflowsDir ?? 'workspace/workflows'
    return buildWorkflowsRoutes(workflowsDir, deps.runner as ActorRef<WorkflowRunnerMsg> | null, getWorkflowRunsDir(workflowsDir))
  },
  uiSurface: workflowsSurfaceRegistration,
})