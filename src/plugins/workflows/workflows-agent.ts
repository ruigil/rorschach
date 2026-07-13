import type { ToolCollection } from '../../types/tools.ts'
import type { AgentDescriptor, AgentModelOptions } from '../../types/agents.ts'

export type WorkflowsAgentOptions = AgentModelOptions & {
  tools: ToolCollection
}

export const WorkflowsAgentDescriptor = (options: WorkflowsAgentOptions): AgentDescriptor => {
  const systemPrompt = `You are a workflow assistant.

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

  return {
    mode: 'workflows',
    role: 'reasoning',
    displayName: 'Plans & Workflows',
    shortDesc: 'Design plans, save, inspect, and run workflows',
    systemPrompt,
    internalTools: Object.values(options.tools || {}),
    toolFilter: options.toolFilter,
    capabilities: { userVisible: true },
    model: options.model,
    maxToolLoops: options.maxToolLoops ?? 25,
  }
}
