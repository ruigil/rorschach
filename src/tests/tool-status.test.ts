import { describe, test, expect } from 'bun:test'
import { createPluginSystem, ask } from '../system/index.ts'
import type { ActorDef, ActorRef } from '../system/index.ts'
import { createToolStatusActor, createInitialToolStatusState, TOOL_STATUS_TOOL_NAME } from '../plugins/tools/tool-status.ts'
import { JobRegistryTopic } from '../types/tools.ts'
import type { ToolMsg, ToolReply } from '../types/tools.ts'

const tick = (ms = 50) => Bun.sleep(ms)

// A fake long-running tool: replies with toolPending or toolResult based on its
// internal state, controlled by direct topic events from the test.

type FakeToolState = { jobs: Record<string, { done: boolean; result: string }> }
type FakeMsg = ToolMsg | { type: '_finish'; jobId: string }

const createFakeTool = (): ActorDef<FakeMsg, FakeToolState> => ({
  handler: (state, msg) => {
    if (msg.type === 'invoke') {
      msg.replyTo.send({ type: 'toolError', error: 'use direct registry events' })
      return { state }
    }
    if (msg.type === 'jobStatus') {
      const job = state.jobs[msg.jobId]
      if (!job) {
        msg.replyTo.send({ type: 'toolError', error: `unknown job ${msg.jobId}` })
        return { state }
      }
      if (job.done) {
        msg.replyTo.send({ type: 'toolResult', result: job.result })
      } else {
        msg.replyTo.send({ type: 'toolPending', jobId: msg.jobId })
      }
      return { state }
    }
    if (msg.type === '_finish') {
      const job = state.jobs[msg.jobId]
      if (!job) return { state }
      return { state: { jobs: { ...state.jobs, [msg.jobId]: { ...job, done: true } } } }
    }
    return { state }
  },
})

describe('tool_status', () => {
  test('lookup by jobId forwards a fresh jobStatus to the underlying tool', async () => {
    const system = await createPluginSystem()
    const fakeTool = system.spawn('fake-tool', createFakeTool(), {
      jobs: { 'job-1': { done: false, result: 'eventual' } },
    }) as unknown as ActorRef<ToolMsg>

    const statusRef = system.spawn(
      'tool-status',
      createToolStatusActor(),
      createInitialToolStatusState(),
    ) as unknown as ActorRef<ToolMsg>
    await tick()

    // Register a running job in the JobRegistry — tool_status should pick it up via subscription
    system.publishRetained(JobRegistryTopic, 'job-1', {
      jobId: 'job-1',
      status: 'running',
      toolName: 'fake-tool',
      toolRef: fakeTool,
      startedAt: Date.now() - 5000,
    })
    await tick()

    const reply = await ask<ToolMsg, ToolReply>(
      statusRef,
      (replyTo) => ({
        type: 'invoke',
        toolName: TOOL_STATUS_TOOL_NAME,
        arguments: JSON.stringify({ jobId: 'job-1' }),
        replyTo,
        userId: 'tester',
      }),
      { timeoutMs: 2000 },
    )

    expect(reply.type).toBe('toolResult')
    expect((reply as { type: 'toolResult'; result: string }).result).toContain('still running')
    expect((reply as { type: 'toolResult'; result: string }).result).toContain('job-1')
    expect((reply as { type: 'toolResult'; result: string }).result).toContain('fake-tool')
    await system.shutdown()
  })

  test('list mode (no jobId) returns active jobs with age', async () => {
    const system = await createPluginSystem()
    const fakeTool = system.spawn('fake-tool-2', createFakeTool(), {
      jobs: { 'jA': { done: false, result: '' }, 'jB': { done: false, result: '' } },
    }) as unknown as ActorRef<ToolMsg>

    const statusRef = system.spawn(
      'tool-status-2',
      createToolStatusActor(),
      createInitialToolStatusState(),
    ) as unknown as ActorRef<ToolMsg>
    await tick()

    system.publishRetained(JobRegistryTopic, 'jA', { jobId: 'jA', status: 'running', toolName: 't1', toolRef: fakeTool, startedAt: Date.now() })
    system.publishRetained(JobRegistryTopic, 'jB', { jobId: 'jB', status: 'running', toolName: 't2', toolRef: fakeTool, startedAt: Date.now() })
    await tick()

    const reply = await ask<ToolMsg, ToolReply>(
      statusRef,
      (replyTo) => ({
        type: 'invoke',
        toolName: TOOL_STATUS_TOOL_NAME,
        arguments: '{}',
        replyTo,
        userId: 'tester',
      }),
      { timeoutMs: 2000 },
    )

    expect(reply.type).toBe('toolResult')
    const text = (reply as { type: 'toolResult'; result: string }).result
    expect(text).toContain('jA')
    expect(text).toContain('jB')
    expect(text).toContain('t1')
    expect(text).toContain('t2')
    await system.shutdown()
  })

  test('cleared job is removed and lookup reports it gone', async () => {
    const system = await createPluginSystem()
    const fakeTool = system.spawn('fake-tool-3', createFakeTool(), {
      jobs: {},
    }) as unknown as ActorRef<ToolMsg>

    const statusRef = system.spawn(
      'tool-status-3',
      createToolStatusActor(),
      createInitialToolStatusState(),
    ) as unknown as ActorRef<ToolMsg>
    await tick()

    system.publishRetained(JobRegistryTopic, 'jX', { jobId: 'jX', status: 'running', toolName: 'fake-tool', toolRef: fakeTool, startedAt: Date.now() })
    await tick()
    system.publishRetained(JobRegistryTopic, 'jX', { jobId: 'jX', status: 'cleared' })
    await tick()

    const reply = await ask<ToolMsg, ToolReply>(
      statusRef,
      (replyTo) => ({
        type: 'invoke',
        toolName: TOOL_STATUS_TOOL_NAME,
        arguments: JSON.stringify({ jobId: 'jX' }),
        replyTo,
        userId: 'tester',
      }),
      { timeoutMs: 2000 },
    )

    expect(reply.type).toBe('toolResult')
    expect((reply as { type: 'toolResult'; result: string }).result).toContain('No active job')
    await system.shutdown()
  })

  test('empty list when no jobs are active', async () => {
    const system = await createPluginSystem()
    const statusRef = system.spawn(
      'tool-status-4',
      createToolStatusActor(),
      createInitialToolStatusState(),
    ) as unknown as ActorRef<ToolMsg>
    await tick()

    const reply = await ask<ToolMsg, ToolReply>(
      statusRef,
      (replyTo) => ({
        type: 'invoke',
        toolName: TOOL_STATUS_TOOL_NAME,
        arguments: '{}',
        replyTo,
        userId: 'tester',
      }),
      { timeoutMs: 2000 },
    )

    expect(reply.type).toBe('toolResult')
    expect((reply as { type: 'toolResult'; result: string }).result).toBe('No active jobs.')
    await system.shutdown()
  })
})
