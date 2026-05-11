import { describe, test, expect } from 'bun:test'
import { SystemPlugin, ask } from '../system/index.ts'
import type { ActorDef, ActorRef } from '../system/index.ts'
import { ToolStatus, TOOL_STATUS_TOOL_NAME } from '../plugins/tools/tool-status.ts'
import { JobRegistryTopic } from '../types/tools.ts'
import type { JobLifecycleEvent, ToolMsg, ToolReply } from '../types/tools.ts'

const tick = (ms = 50) => Bun.sleep(ms)

// A fake long-running tool: stores jobs and publishes completion to
// JobRegistryTopic when `_finish` is received, simulating the topic-based
// completion flow.
//
// The tool itself no longer needs a `jobStatus` handler — tool_status serves
// status from its cached topic-derived state.

type FakeToolState = { jobs: Record<string, { result: string }> }
type FakeInternalMsg = { type: '_finish'; jobId: string } | { type: '_fail'; jobId: string; error: string }
type FakeMsg = ToolMsg | FakeInternalMsg

const createFakeTool = (): ActorDef<FakeMsg, FakeToolState> => ({
  handler: (state, msg, ctx) => {
    if (msg.type === 'invoke') {
      msg.replyTo.send({ type: 'toolError', error: 'use direct registry events' })
      return { state }
    }
    if (msg.type === '_finish') {
      const job = state.jobs[msg.jobId]
      if (!job) return { state }
      ctx.publish(JobRegistryTopic, { jobId: msg.jobId, status: 'completed', result: { text: job.result } } as JobLifecycleEvent)
      return { state }
    }
    if (msg.type === '_fail') {
      const job = state.jobs[msg.jobId]
      if (!job) return { state }
      ctx.publish(JobRegistryTopic, { jobId: msg.jobId, status: 'failed', error: msg.error } as JobLifecycleEvent)
      return { state }
    }
    return { state }
  },
})

describe('tool_status', () => {
  test('status of running job served from cached topic state', async () => {
    const system = await SystemPlugin()
    const fakeTool = system.spawn('fake-tool', createFakeTool(), { state: {
      jobs: { 'job-1': { result: 'eventual' } },
    } }) as unknown as ActorRef<ToolMsg>

    const statusRef = system.spawn(
      "tool-status",
      ToolStatus(),
    ) as unknown as ActorRef<ToolMsg>
    await tick()

    // Register a running job in the JobRegistry — tool_status picks it up via subscription
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
    expect((reply as { type: 'toolResult'; result: { text: string } }).result.text).toContain('still running')
    expect((reply as { type: 'toolResult'; result: { text: string } }).result.text).toContain('job-1')
    expect((reply as { type: 'toolResult'; result: { text: string } }).result.text).toContain('fake-tool')
    await system.shutdown()
  })

  test('completed job status shows result from topic', async () => {
    const system = await SystemPlugin()
    const fakeTool = system.spawn('fake-tool-c', createFakeTool(), { state: {
      jobs: { 'job-c': { result: 'all done' } },
    } }) as unknown as ActorRef<ToolMsg>

    const statusRef = system.spawn(
      'tool-status-c',
      ToolStatus()
    ) as unknown as ActorRef<ToolMsg>
    await tick()

    // Register running
    system.publishRetained(JobRegistryTopic, 'job-c', {
      jobId: 'job-c',
      status: 'running',
      toolName: 'fake-tool',
      toolRef: fakeTool,
      startedAt: Date.now() - 5000,
    })
    await tick()

    // Tool publishes completion via the topic
    ;(fakeTool as unknown as ActorRef<FakeInternalMsg>).send({ type: '_finish', jobId: 'job-c' })
    await tick()

    const reply = await ask<ToolMsg, ToolReply>(
      statusRef,
      (replyTo) => ({
        type: 'invoke',
        toolName: TOOL_STATUS_TOOL_NAME,
        arguments: JSON.stringify({ jobId: 'job-c' }),
        replyTo,
        userId: 'tester',
      }),
      { timeoutMs: 2000 },
    )

    expect(reply.type).toBe('toolResult')
    expect((reply as { type: 'toolResult'; result: { text: string } }).result.text).toContain('completed')
    expect((reply as { type: 'toolResult'; result: { text: string } }).result.text).toContain('all done')
    await system.shutdown()
  })

  test('failed job status shows error from topic', async () => {
    const system = await SystemPlugin()
    const fakeTool = system.spawn('fake-tool-f', createFakeTool(), { state: {
      jobs: { 'job-f': { result: '' } },
    } }) as unknown as ActorRef<ToolMsg>

    const statusRef = system.spawn(
      'tool-status-f',
      ToolStatus()
    ) as unknown as ActorRef<ToolMsg>
    await tick()

    system.publishRetained(JobRegistryTopic, 'job-f', {
      jobId: 'job-f',
      status: 'running',
      toolName: 'fake-tool',
      toolRef: fakeTool,
      startedAt: Date.now() - 5000,
    })
    await tick()

    ;(fakeTool as unknown as ActorRef<FakeInternalMsg>).send({ type: '_fail', jobId: 'job-f', error: 'network timeout' })
    await tick()

    const reply = await ask<ToolMsg, ToolReply>(
      statusRef,
      (replyTo) => ({
        type: 'invoke',
        toolName: TOOL_STATUS_TOOL_NAME,
        arguments: JSON.stringify({ jobId: 'job-f' }),
        replyTo,
        userId: 'tester',
      }),
      { timeoutMs: 2000 },
    )

    expect(reply.type).toBe('toolResult')
    expect((reply as { type: 'toolResult'; result: { text: string } }).result.text).toContain('failed')
    expect((reply as { type: 'toolResult'; result: { text: string } }).result.text).toContain('network timeout')
    await system.shutdown()
  })

  test('list mode (no jobId) returns active jobs with age', async () => {
    const system = await SystemPlugin()
    const fakeTool = system.spawn('fake-tool-2', createFakeTool(), { state: {
      jobs: { 'jA': { result: '' }, 'jB': { result: '' } },
    } }) as unknown as ActorRef<ToolMsg>

    const statusRef = system.spawn(
      'tool-status-2',
      ToolStatus()
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
    const text = (reply as { type: 'toolResult'; result: { text: string } }).result.text
    expect(text).toContain('jA')
    expect(text).toContain('jB')
    expect(text).toContain('t1')
    expect(text).toContain('t2')
    await system.shutdown()
  })

  test('cleared job is removed and lookup reports it gone', async () => {
    const system = await SystemPlugin()
    const fakeTool = system.spawn('fake-tool-3', createFakeTool(), { state: {
      jobs: {},
    } }) as unknown as ActorRef<ToolMsg>

    const statusRef = system.spawn(
      'tool-status-3',
      ToolStatus()
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
    expect((reply as { type: 'toolResult'; result: { text: string } }).result.text).toContain('No active job')
    await system.shutdown()
  })

  test('empty list when no jobs are active', async () => {
    const system = await SystemPlugin()
    const statusRef = system.spawn(
      'tool-status-4',
      ToolStatus()
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
    expect((reply as { type: 'toolResult'; result: { text: string } }).result.text).toBe('No active jobs.')
    await system.shutdown()
  })
})
