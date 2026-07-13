import { describe, expect, test } from 'bun:test'
import { AgentSystem, type ActorDef, type ActorRef } from '../system/index.ts'
import {
  blockWorkflowTaskTool,
  completeWorkflowTaskTool,
  WorkflowTaskExecutor,
} from '../plugins/workflows/workflow-task-executor.ts'
import type {
  Workflow,
  WorkflowRunExecutorMsg,
  WorkflowTask,
  WorkflowTaskExecutorMsg,
} from '../plugins/workflows/types.ts'
import type { LlmProviderMsg } from '../types/llm.ts'
import type { ToolCollection } from '../types/tools.ts'

const tick = (ms = 80) => Bun.sleep(ms)

const workflow: Workflow = {
  id: 'workflow-1',
  userId: 'u1',
  goal: 'Generate a report',
  context: 'Task executor test workflow.',
  createdAt: '2026-06-12T10:00:00.000Z',
  executionTools: [],
  outputs: { report: { type: 'artifact' } },
  tasks: [],
}

const task: WorkflowTask = {
  id: 'write-report',
  name: 'Write report',
  description: 'Write the report artifact.',
  validationCriteria: 'The report artifact exists.',
  dependencies: [],
  outputs: { report: { type: 'artifact' } },
}

type ParentEvent =
  | Extract<WorkflowRunExecutorMsg, { type: 'taskCompleted' }>
  | Extract<WorkflowRunExecutorMsg, { type: 'taskBlocked' }>
  | Extract<WorkflowRunExecutorMsg, { type: 'taskFailed' }>

const ParentRecorder = (events: ParentEvent[]): ActorDef<WorkflowRunExecutorMsg, null> => ({
  initialState: null,
  handler: (state, msg) => {
    if (msg.type === 'taskCompleted' || msg.type === 'taskBlocked' || msg.type === 'taskFailed') events.push(msg)
    return { state }
  },
})

const SequenceLlm = (
  onStream: (msg: Extract<LlmProviderMsg, { type: 'stream' }>, count: number) => void,
): ActorDef<LlmProviderMsg, { count: number }> => ({
  initialState: () => ({ count: 0 }),
  handler: (state, msg) => {
    if (msg.type !== 'stream') return { state }
    const count = state.count + 1
    onStream(msg, count)
    return { state: { count } }
  },
})

const startTask = (executor: ActorRef<WorkflowTaskExecutorMsg>): void => {
  executor.send({
    type: 'startTask',
    workflow,
    task,
    inputs: {},
    dependencyOutputs: {},
    userId: 'u1',
  })
}

describe('workflow task executor', () => {
  test('complete_workflow_task completes the task with validated outputs', async () => {
    const system = await AgentSystem()
    const events: ParentEvent[] = []
    const parent = system.spawn('parent-complete', ParentRecorder(events))
    const llm = system.spawn('llm-complete', SequenceLlm((msg, count) => {
      if (count === 1) {
        expect(msg.tools?.map(tool => tool.function.name)).toContain(completeWorkflowTaskTool.name)
        msg.replyTo.send({
          type: 'llmToolCalls',
          requestId: msg.requestId,
          usage: null,
          calls: [{
            id: 'complete-1',
            name: completeWorkflowTaskTool.name,
            arguments: JSON.stringify({
              summary: 'Wrote the report.',
              outputs: { report: { type: 'artifact', path: 'report.html', mimeType: 'text/html' } },
            }),
          }],
        })
      } else {
        msg.replyTo.send({ type: 'llmDone', requestId: msg.requestId, usage: null })
      }
    }))
    const executor = system.spawn('task-complete', WorkflowTaskExecutor(parent, llm, 'test-model', 3, {} as ToolCollection))

    startTask(executor)
    await tick()

    expect(events).toHaveLength(1)
    expect(events[0]).toEqual({
      type: 'taskCompleted',
      taskId: 'write-report',
      summary: 'Wrote the report.',
      outputs: { report: { type: 'artifact', path: 'report.html', mimeType: 'text/html' } },
    })
    await system.shutdown()
  })

  test('invalid completion args return a tool error and allow retry', async () => {
    const system = await AgentSystem()
    const events: ParentEvent[] = []
    const parent = system.spawn('parent-retry', ParentRecorder(events))
    const llm = system.spawn('llm-retry', SequenceLlm((msg, count) => {
      if (count === 1) {
        msg.replyTo.send({
          type: 'llmToolCalls',
          requestId: msg.requestId,
          usage: null,
          calls: [{
            id: 'complete-bad',
            name: completeWorkflowTaskTool.name,
            arguments: JSON.stringify({
              summary: 'Wrote the report.',
              outputs: { extra: true },
            }),
          }],
        })
        return
      }
      if (count === 2) {
        expect(JSON.stringify(msg.messages)).toContain('task write-report output is not declared: extra')
        msg.replyTo.send({
          type: 'llmToolCalls',
          requestId: msg.requestId,
          usage: null,
          calls: [{
            id: 'complete-good',
            name: completeWorkflowTaskTool.name,
            arguments: JSON.stringify({
              summary: 'Wrote the report.',
              outputs: { report: { type: 'artifact', path: 'report.html' } },
            }),
          }],
        })
        return
      }
      msg.replyTo.send({ type: 'llmDone', requestId: msg.requestId, usage: null })
    }))
    const executor = system.spawn('task-retry', WorkflowTaskExecutor(parent, llm, 'test-model', 4, {} as ToolCollection))

    startTask(executor)
    await tick(120)

    expect(events).toHaveLength(1)
    expect(events[0]?.type).toBe('taskCompleted')
    await system.shutdown()
  })

  test('ending without a terminal control tool fails the task', async () => {
    const system = await AgentSystem()
    const events: ParentEvent[] = []
    const parent = system.spawn('parent-no-terminal', ParentRecorder(events))
    const llm = system.spawn('llm-no-terminal', SequenceLlm((msg) => {
      msg.replyTo.send({ type: 'llmChunk', requestId: msg.requestId, text: '{"summary":"not accepted"}' })
      msg.replyTo.send({ type: 'llmDone', requestId: msg.requestId, usage: null })
    }))
    const executor = system.spawn('task-no-terminal', WorkflowTaskExecutor(parent, llm, 'test-model', 3, {} as ToolCollection))

    startTask(executor)
    await tick()

    expect(events).toEqual([{
      type: 'taskFailed',
      taskId: 'write-report',
      error: 'Task ended without calling complete_workflow_task or block_workflow_task.',
    }])
    await system.shutdown()
  })

  test('block_workflow_task blocks the task', async () => {
    const system = await AgentSystem()
    const events: ParentEvent[] = []
    const parent = system.spawn('parent-block', ParentRecorder(events))
    const llm = system.spawn('llm-block', SequenceLlm((msg, count) => {
      if (count === 1) {
        expect(msg.tools?.map(tool => tool.function.name)).toContain(blockWorkflowTaskTool.name)
        msg.replyTo.send({
          type: 'llmToolCalls',
          requestId: msg.requestId,
          usage: null,
          calls: [{
            id: 'block-1',
            name: blockWorkflowTaskTool.name,
            arguments: JSON.stringify({ reason: 'Missing source data.' }),
          }],
        })
      } else {
        msg.replyTo.send({ type: 'llmDone', requestId: msg.requestId, usage: null })
      }
    }))
    const executor = system.spawn('task-block', WorkflowTaskExecutor(parent, llm, 'test-model', 3, {} as ToolCollection))

    startTask(executor)
    await tick()

    expect(events).toEqual([{
      type: 'taskBlocked',
      taskId: 'write-report',
      message: 'Missing source data.',
    }])
    await system.shutdown()
  })
})
