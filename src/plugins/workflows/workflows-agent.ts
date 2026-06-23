import { defineAgent, getTodayDateString } from '../../system/index.ts'
import type { ActorRef, LoopState } from '../../system/index.ts'
import type { ToolCollection } from '../../types/tools.ts'
import type { AgentModelOptions } from '../../types/agents.ts'
import type { ContextView } from '../../system/index.ts'
import type { WorkflowsAgentMsg } from './types.ts'

type WorkflowsAgentState = {
  loop: LoopState
  contextView: ContextView
  tools: ToolCollection
}

export type WorkflowsAgentOptions = AgentModelOptions & {
  workflowsDir: string
  tools: ToolCollection
}


const buildSystemPrompt = (): string =>
  `You are a workflow assistant. Today is ${getTodayDateString('local')}.

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

export const WorkflowsAgentFactory = defineAgent<WorkflowsAgentOptions, WorkflowsAgentMsg, WorkflowsAgentState>({
  role: 'reasoning',
  spanName: 'workflows-agent',
  logPrefix: 'workflows-agent',
  mode: 'workflows',
  buildSystemPrompt,
  errorMessages: {
    llm: 'The workflows agent encountered an error. Please try again.',
    loopLimit: 'Tool loop limit reached in workflows. Please try again.',
  },
})
