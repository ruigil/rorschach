import { describe, expect, test } from 'bun:test'
import { AgentSystem, ask } from '../system/index.ts'
import { PersistenceProviderTopic, type PersistenceMsg, type PResult } from '../types/persistence.ts'
import { JobRegistryTopic, type JobLifecycleEvent, type ToolMsg, type ToolReply } from '../types/tools.ts'
import { Cron } from '../plugins/tools/cron.ts'
import { MockPersistenceActor } from './mock-persistence.ts'
import type { ActorRef } from '../system/index.ts'

const tick = (ms = 50) => Bun.sleep(ms)

describe('cron job registry integration', () => {
  test('cron_create returns toolPending; delete clears the schedule job', async () => {
    const system = await AgentSystem({ plugins: [MockPersistenceActor()] })
    const events: JobLifecycleEvent[] = []
    system.subscribe(JobRegistryTopic, e => { events.push(e) })

    const cron = system.spawn('cron', Cron()) as unknown as ActorRef<ToolMsg>
    await tick()

    const reply = await ask<ToolMsg, ToolReply>(
      cron,
      replyTo => ({
        type: 'invoke',
        toolName: 'cron_create',
        arguments: JSON.stringify({
          expression: '0 9 * * *',
          prompt: 'daily check-in',
          run_once: true,
        }),
        userId: 'u1',
        replyTo,
      }),
    )

    expect(reply.type).toBe('toolPending')
    if (reply.type !== 'toolPending') return
    expect(reply.placeholderText).toContain('Scheduled')
    expect(reply.placeholderText).toContain(reply.jobId)

    // Simulate invokeTool registering running at schedule time
    system.publishRetained(JobRegistryTopic, reply.jobId, {
      jobId: reply.jobId,
      status: 'running',
      toolName: 'cron_create',
      toolRef: cron,
      startedAt: Date.now(),
      userId: 'u1',
    })
    await tick()

    const del = await ask<ToolMsg, ToolReply>(
      cron,
      replyTo => ({
        type: 'invoke',
        toolName: 'cron_delete',
        arguments: JSON.stringify({ jobId: reply.jobId }),
        userId: 'u1',
        replyTo,
      }),
    )
    expect(del.type).toBe('toolResult')
    await tick()

    expect(events.some(e => e.jobId === reply.jobId && e.status === 'cleared')).toBe(true)

    await system.shutdown()
  })

  test('restore arms with running; due fire publishes completed only', async () => {
    const system = await AgentSystem({ plugins: [MockPersistenceActor()] })
    let persist: ActorRef<PersistenceMsg> | null = null
    system.subscribe(PersistenceProviderTopic, e => { persist = e.ref })
    await tick()
    expect(persist).toBeTruthy()

    const scheduleId = 'sched-due-1'
    const put = await ask<PersistenceMsg, PResult>(persist!, replyTo => ({
      type: 'kv.put',
      key: 'tools/cron-jobs',
      value: {
        jobs: {
          [scheduleId]: {
            id: scheduleId,
            expression: '0 9 * * *',
            prompt: 'fire-me-now',
            runOnce: true,
            createdAt: Date.now() - 10_000,
            lastFiredAt: null,
            nextFireAt: Date.now() - 5_000,
            userId: 'u-fire',
          },
        },
      },
      replyTo,
    }))
    expect(put.ok).toBe(true)

    const events: JobLifecycleEvent[] = []
    system.subscribe(JobRegistryTopic, e => { events.push(e) })

    system.spawn('cron-due', Cron())
    await tick(150)

    const runningIdx = events.findIndex(e => e.jobId === scheduleId && e.status === 'running')
    const completedIdx = events.findIndex(e => e.jobId === scheduleId && e.status === 'completed')
    expect(runningIdx).toBeGreaterThanOrEqual(0)
    expect(completedIdx).toBeGreaterThan(runningIdx)

    const running = events[runningIdx]!
    if (running.status === 'running') {
      expect(running.toolName).toBe('cron_create')
      expect(running.userId).toBe('u-fire')
    }

    const completed = events[completedIdx]!
    if (completed.status === 'completed') {
      expect(completed.result.text).toBe('fire-me-now')
    }

    // Fire must not emit a second running after arm
    const runningCount = events.filter(e => e.jobId === scheduleId && e.status === 'running').length
    expect(runningCount).toBe(1)

    await system.shutdown()
  })

  test('recurring fire re-arms same id with running after completed', async () => {
    const system = await AgentSystem({ plugins: [MockPersistenceActor()] })
    let persist: ActorRef<PersistenceMsg> | null = null
    system.subscribe(PersistenceProviderTopic, e => { persist = e.ref })
    await tick()
    expect(persist).toBeTruthy()

    const scheduleId = 'sched-recur-1'
    await ask<PersistenceMsg, PResult>(persist!, replyTo => ({
      type: 'kv.put',
      key: 'tools/cron-jobs',
      value: {
        jobs: {
          [scheduleId]: {
            id: scheduleId,
            expression: '0 9 * * *',
            prompt: 'recur-prompt',
            runOnce: false,
            createdAt: Date.now() - 10_000,
            lastFiredAt: null,
            nextFireAt: Date.now() - 5_000,
            userId: 'u-recur',
          },
        },
      },
      replyTo,
    }))

    const events: JobLifecycleEvent[] = []
    system.subscribe(JobRegistryTopic, e => { events.push(e) })

    system.spawn('cron-recur', Cron())
    await tick(150)

    // arm (start) → completed (fire) → running (re-arm), same id throughout
    const forId = events.filter(e => e.jobId === scheduleId)
    expect(forId.map(e => e.status)).toEqual(['running', 'completed', 'running'])

    const completed = forId.find(e => e.status === 'completed')
    if (completed && completed.status === 'completed') {
      expect(completed.result.text).toBe('recur-prompt')
    }

    await system.shutdown()
  })

  test('cron_create respects explicit timezone arguments', async () => {
    const system = await AgentSystem({ plugins: [MockPersistenceActor()] })
    const cron = system.spawn('cron-tz', Cron()) as unknown as ActorRef<ToolMsg>
    await tick()

    const reply = await ask<ToolMsg, ToolReply>(
      cron,
      replyTo => ({
        type: 'invoke',
        toolName: 'cron_create',
        arguments: JSON.stringify({
          expression: '0 9 * * *',
          prompt: 'morning alert',
          timezone: 'America/New_York',
          run_once: true,
        }),
        userId: 'u1',
        replyTo,
      }),
    )

    expect(reply.type).toBe('toolPending')
    if (reply.type !== 'toolPending') return
    expect(reply.placeholderText).toContain('Next run')
    expect(/-0[45]:00/.test(reply.placeholderText ?? '')).toBe(true)

    await system.shutdown()
  })
})
