import { describe, test, expect } from 'bun:test'
import { AgentSystem, ask } from '../system/index.ts'
import type { ActorDef, ActorRef } from '../system/index.ts'
import { ToolStatus } from '../plugins/tools/tool-status.ts'
import { JobRegistryTopic } from '../types/tools.ts'
import type { JobLifecycleEvent } from '../types/tools.ts'
import type { SCRInvokeMsg, SCRReply } from '../types/scr.ts'

const tick = (ms = 50) => Bun.sleep(ms)

type FakeToolState = { jobs: Record<string, { result: string }> }
type FakeInternalMsg = { type: '_finish'; jobId: string } | { type: '_fail'; jobId: string; error: string }
type FakeMsg = SCRInvokeMsg | FakeInternalMsg

const createFakeTool = (): ActorDef<FakeMsg, FakeToolState> => ({
  handler: (state, msg, ctx) => {
    if (msg.type === 'invoke') {
      msg.replyTo.send({ type: 'error', error: 'use direct registry events' })
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

describe('tools_status', () => {
  test('status of running job served from cached topic state', async () => {
    const system = await AgentSystem()
    const fakeTool = system.spawn('fake-tool', createFakeTool(), { state: {
      jobs: { 'job-1': { result: 'eventual' } },
    } })

    const statusRef = system.spawn(
      'tool-status',
      ToolStatus(),
    )
    await tick()

    // Register a running job in the JobRegistry — tools_status picks it up via subscription
    system.publishRetained(JobRegistryTopic, 'job-1', {
      jobId: 'job-1',
      status: 'running',
      toolName: 'fake-tool',
      toolRef: fakeTool,
      startedAt: Date.now() - 5000,
    })
    await tick()

    const reply = await ask<SCRInvokeMsg, SCRReply>(
      statusRef,
      (replyTo) => ({
        type: 'invoke',
        urn: 'scr:leaf:tools.tool_status',
        input: { jobId: 'job-1' },
        replyTo,
      }),
      { timeoutMs: 2000 },
    )

    expect(reply.type).toBe('result')
    expect(((reply as { type: 'result'; output: { text: string } }).output).text).toContain('still running')
    expect(((reply as { type: 'result'; output: { text: string } }).output).text).toContain('job-1')
    expect(((reply as { type: 'result'; output: { text: string } }).output).text).toContain('fake-tool')
    await system.shutdown()
  })

  test('completed job status shows result from topic', async () => {
    const system = await AgentSystem()
    const fakeTool = system.spawn('fake-tool-c', createFakeTool(), { state: {
      jobs: { 'job-c': { result: 'all done' } },
    } })

    const statusRef = system.spawn(
      'tool-status-c',
      ToolStatus()
    )
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

    const reply = await ask<SCRInvokeMsg, SCRReply>(
      statusRef,
      (replyTo) => ({
        type: 'invoke',
        urn: 'scr:leaf:tools.tool_status',
        input: { jobId: 'job-c' },
        replyTo,
      }),
      { timeoutMs: 2000 },
    )

    expect(reply.type).toBe('result')
    expect(((reply as { type: 'result'; output: { text: string } }).output).text).toContain('completed')
    expect(((reply as { type: 'result'; output: { text: string } }).output).text).toContain('all done')
    await system.shutdown()
  })

  test('failed job status shows error from topic', async () => {
    const system = await AgentSystem()
    const fakeTool = system.spawn('fake-tool-f', createFakeTool(), { state: {
      jobs: { 'job-f': { result: '' } },
    } })

    const statusRef = system.spawn(
      'tool-status-f',
      ToolStatus()
    )
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

    const reply = await ask<SCRInvokeMsg, SCRReply>(
      statusRef,
      (replyTo) => ({
        type: 'invoke',
        urn: 'scr:leaf:tools.tool_status',
        input: { jobId: 'job-f' },
        replyTo,
      }),
      { timeoutMs: 2000 },
    )

    expect(reply.type).toBe('result')
    expect(((reply as { type: 'result'; output: { text: string } }).output).text).toContain('failed')
    expect(((reply as { type: 'result'; output: { text: string } }).output).text).toContain('network timeout')
    await system.shutdown()
  })

  test('list mode (no jobId) returns active jobs with age', async () => {
    const system = await AgentSystem()
    const fakeTool = system.spawn('fake-tool-2', createFakeTool(), { state: {
      jobs: { 'jA': { result: '' }, 'jB': { result: '' } },
    } })

    const statusRef = system.spawn(
      'tool-status-2',
      ToolStatus()
    )
    await tick()

    system.publishRetained(JobRegistryTopic, 'jA', { jobId: 'jA', status: 'running', toolName: 't1', toolRef: fakeTool, startedAt: Date.now() })
    system.publishRetained(JobRegistryTopic, 'jB', { jobId: 'jB', status: 'running', toolName: 't2', toolRef: fakeTool, startedAt: Date.now() })
    await tick()

    const reply = await ask<SCRInvokeMsg, SCRReply>(
      statusRef,
      (replyTo) => ({
        type: 'invoke',
        urn: 'scr:leaf:tools.tool_status',
        input: {},
        replyTo,
      }),
      { timeoutMs: 2000 },
    )

    expect(reply.type).toBe('result')
    const text = ((reply as { type: 'result'; output: { text: string } }).output).text
    expect(text).toContain('jA')
    expect(text).toContain('jB')
    expect(text).toContain('t1')
    expect(text).toContain('t2')
    await system.shutdown()
  })

  test('cleared job is removed and lookup reports it gone', async () => {
    const system = await AgentSystem()
    const fakeTool = system.spawn('fake-tool-3', createFakeTool(), { state: {
      jobs: {},
    } })

    const statusRef = system.spawn(
      'tool-status-3',
      ToolStatus()
    )
    await tick()

    system.publishRetained(JobRegistryTopic, 'jX', { jobId: 'jX', status: 'running', toolName: 'fake-tool', toolRef: fakeTool, startedAt: Date.now() })
    await tick()
    system.publishRetained(JobRegistryTopic, 'jX', { jobId: 'jX', status: 'cleared' })
    await tick()

    const reply = await ask<SCRInvokeMsg, SCRReply>(
      statusRef,
      (replyTo) => ({
        type: 'invoke',
        urn: 'scr:leaf:tools.tool_status',
        input: { jobId: 'jX' },
        replyTo,
      }),
      { timeoutMs: 2000 },
    )

    expect(reply.type).toBe('result')
    expect(((reply as { type: 'result'; output: { text: string } }).output).text).toContain('No active job')
    await system.shutdown()
  })

  test('empty list when no jobs are active', async () => {
    const system = await AgentSystem()
    const statusRef = system.spawn(
      'tool-status-4',
      ToolStatus()
    )
    await tick()

    const reply = await ask<SCRInvokeMsg, SCRReply>(
      statusRef,
      (replyTo) => ({
        type: 'invoke',
        urn: 'scr:leaf:tools.tool_status',
        input: {},
        replyTo,
      }),
      { timeoutMs: 2000 },
    )

    expect(reply.type).toBe('result')
    expect(((reply as { type: 'result'; output: { text: string } }).output).text).toBe('No active jobs.')
    await system.shutdown()
  })
})
