import { describe, test, expect } from 'bun:test'
import { createPluginSystem, invokeTool } from '../system/index.ts'
import type { ActorDef, ActorRef } from '../system/index.ts'
import { JobRegistryTopic } from '../types/tools.ts'
import type {
  JobLifecycleEvent,
  ToolFinalReply,
  ToolMsg,
} from '../types/tools.ts'

// ─── Helpers ───

const tick = (ms = 50) => Bun.sleep(ms)

// ─── Configurable test tool ───
//
// On `invoke`: replies according to its `mode`. Modes:
//   - 'syncResult' / 'syncError'    → final reply immediately
//   - 'pending'                     → toolPending first, then publishes
//                                     completion/failure to JobRegistryTopic
//                                     after `delayMs` via an actor timer.

type TestInternalMsg = { type: '_complete'; jobId: string }

type ToolMode =
  | { kind: 'syncResult'; result: string }
  | { kind: 'syncError';  error:  string }
  | { kind: 'pending'; eventually: ToolFinalReply; delayMs: number; placeholder?: string }

type ToolState = {
  mode: ToolMode
  jobs: Record<string, ToolFinalReply>
}

type TestMsg = ToolMsg | TestInternalMsg

const createTestTool = (mode: ToolMode): ActorDef<TestMsg, ToolState> => ({
  handler: (state, msg, ctx) => {
    if (msg.type === 'invoke') {
      if (state.mode.kind === 'syncResult') {
        msg.replyTo.send({ type: 'toolResult', result: { text: state.mode.result } })
        return { state }
      }
      if (state.mode.kind === 'syncError') {
        msg.replyTo.send({ type: 'toolError', error: state.mode.error })
        return { state }
      }
      // pending mode: start a timer to simulate long-running completion
      const jobId = `job-${Object.keys(state.jobs).length + 1}`
      msg.replyTo.send({
        type: 'toolPending',
        jobId,
        placeholderText: state.mode.placeholder,
      })
      ctx.timers.startSingleTimer(`test-tool:${jobId}`, { type: '_complete', jobId }, state.mode.delayMs)
      return {
        state: {
          ...state,
          jobs: { ...state.jobs, [jobId]: state.mode.eventually },
        },
      }
    }
    // _complete: timer fired → publish completion to JobRegistryTopic
    if (msg.type === '_complete') {
      const job = state.jobs[msg.jobId]
      if (!job) return { state }
      const event: JobLifecycleEvent = job.type === 'toolResult'
        ? { jobId: msg.jobId, status: 'completed', result: job.result }
        : { jobId: msg.jobId, status: 'failed',    error: job.error }
      ctx.publish(JobRegistryTopic, event)
      const { [msg.jobId]: _drop, ...rest } = state.jobs
      return { state: { ...state, jobs: rest } }
    }
    return { state }
  },
})

// ─── Caller actor that invokes the tool and records what comes back ───

type CallerMsg =
  | { type: 'go';            replyTo: ActorRef<ToolFinalReply> }
  | { type: 'goWithBg';      replyTo: ActorRef<ToolFinalReply>; updatesTo: ActorRef<ToolFinalReply> }
  | { type: '_immediate';    reply: ToolFinalReply; outerReply: ActorRef<ToolFinalReply> }
  | { type: '_immediateErr'; error: unknown;         outerReply: ActorRef<ToolFinalReply> }
  | { type: '_completion';   reply: ToolFinalReply }

const createCaller = (
  toolRef: ActorRef<ToolMsg>,
  updatesTo: ActorRef<ToolFinalReply> | null = null,
): ActorDef<CallerMsg, null> => ({
  handler: (state, msg, ctx) => {
    if (msg.type === 'go' || msg.type === 'goWithBg') {
      const target = msg.replyTo
      const updates = msg.type === 'goWithBg' ? msg.updatesTo : updatesTo
      ctx.pipeToSelf(
        invokeTool<CallerMsg>(
          ctx,
          toolRef,
          { toolName: 'test-tool', arguments: '{}', userId: 'test-user' },
          updates ? { onCompletion: (reply) => ({ type: '_completion' as const, reply }) } : undefined,
        ),
        (reply) => ({ type: '_immediate' as const, reply, outerReply: target }),
        (err)   => ({ type: '_immediateErr' as const, error: err, outerReply: target }),
      )
      return { state }
    }
    if (msg.type === '_immediate') {
      msg.outerReply.send(msg.reply)
      return { state }
    }
    if (msg.type === '_immediateErr') {
      msg.outerReply.send({ type: 'toolError', error: String(msg.error) })
      return { state }
    }
    // _completion
    if (updatesTo) updatesTo.send(msg.reply)
    return { state }
  },
})

// ─── Tests ───

describe('invokeTool primitive', () => {
  test('sync toolResult: returns result, no polling, no JobRegistry events', async () => {
    const system = await createPluginSystem()
    const events: JobLifecycleEvent[] = []
    system.subscribe(JobRegistryTopic, (e) => { events.push(e) })

    const tool = system.spawn('tool-sync-ok', createTestTool({ kind: 'syncResult', result: 'hi' }), { state: {
      mode: { kind: 'syncResult', result: 'hi' }, jobs: {},
    } }) as unknown as ActorRef<ToolMsg>
    const caller = system.spawn('caller-sync-ok', createCaller(tool))
    await tick()

    const result: ToolFinalReply[] = []
    const sink: ActorRef<ToolFinalReply> = {
      name: 'sink', isAlive: () => true, send: (r) => { result.push(r) },
    }
    caller.send({ type: 'go', replyTo: sink })
    await tick(80)

    expect(result).toHaveLength(1)
    expect(result[0]).toEqual({ type: 'toolResult', result: { text: 'hi' } })
    expect(events).toHaveLength(0)
    await system.shutdown()
  })

  test('sync toolError: returns error directly, no events', async () => {
    const system = await createPluginSystem()
    const events: JobLifecycleEvent[] = []
    system.subscribe(JobRegistryTopic, (e) => { events.push(e) })

    const tool = system.spawn('tool-sync-err', createTestTool({ kind: 'syncError', error: 'nope' }), { state: {
      mode: { kind: 'syncError', error: 'nope' }, jobs: {},
    } }) as unknown as ActorRef<ToolMsg>
    const caller = system.spawn('caller-sync-err', createCaller(tool))
    await tick()

    const result: ToolFinalReply[] = []
    const sink: ActorRef<ToolFinalReply> = { name: 'sink', isAlive: () => true, send: (r) => { result.push(r) } }
    caller.send({ type: 'go', replyTo: sink })
    await tick(80)

    expect(result[0]).toEqual({ type: 'toolError', error: 'nope' })
    expect(events).toHaveLength(0)
    await system.shutdown()
  })

  test('toolPending without onCompletion → graceful toolError fallback', async () => {
    const system = await createPluginSystem()
    const events: JobLifecycleEvent[] = []
    system.subscribe(JobRegistryTopic, (e) => { events.push(e) })

    const mode: ToolMode = { kind: 'pending', eventually: { type: 'toolResult', result: { text: 'done' } }, delayMs: 30 }
    const tool = system.spawn('tool-pending-no-cb', createTestTool(mode), { state: {
      mode, jobs: {},
    } }) as unknown as ActorRef<ToolMsg>
    // Caller without onCompletion
    const caller = system.spawn('caller-no-cb', createCaller(tool))
    await tick()

    const immediate: ToolFinalReply[] = []
    const sink: ActorRef<ToolFinalReply> = { name: 'sink', isAlive: () => true, send: (r) => { immediate.push(r) } }
    caller.send({ type: 'go', replyTo: sink })
    await tick(80)

    expect(immediate).toHaveLength(1)
    expect(immediate[0]?.type).toBe('toolError')
    expect((immediate[0] as { type: 'toolError'; error: string }).error).toContain('does not support background completion')
    await system.shutdown()
  })

  test('toolPending with onCompletion: placeholder now, real result later, registry events emitted', async () => {
    const system = await createPluginSystem()
    const events: JobLifecycleEvent[] = []
    system.subscribe(JobRegistryTopic, (e) => { events.push(e) })

    const mode: ToolMode = {
      kind: 'pending',
      eventually: { type: 'toolResult', result: { text: 'finished work' } },
      delayMs:    40,
      placeholder: 'WORKING…',
    }
    const tool = system.spawn('tool-pending-cb', createTestTool(mode), { state: {
      mode, jobs: {},
    } }) as unknown as ActorRef<ToolMsg>

    const updatesSink: ToolFinalReply[] = []
    const updatesRef: ActorRef<ToolFinalReply> = {
      name: 'updates', isAlive: () => true, send: (r) => { updatesSink.push(r) },
    }
    const caller = system.spawn('caller-cb', createCaller(tool, updatesRef))
    await tick()

    const immediate: ToolFinalReply[] = []
    const sink: ActorRef<ToolFinalReply> = { name: 'sink', isAlive: () => true, send: (r) => { immediate.push(r) } }
    caller.send({ type: 'go', replyTo: sink })
    await tick(30)

    // Immediate placeholder
    expect(immediate).toHaveLength(1)
    expect(immediate[0]).toEqual({ type: 'toolResult', result: { text: 'WORKING…' } })
    // Running event published
    const running = events.find(e => e.status === 'running')
    expect(running).toBeDefined()

    // Wait for timer to complete
    await tick(80)

    expect(updatesSink).toHaveLength(1)
    expect(updatesSink[0]).toEqual({ type: 'toolResult', result: { text: 'finished work' } })

    // Cleared event published after completion
    const cleared = events.find(e => e.status === 'cleared')
    expect(cleared).toBeDefined()
    await system.shutdown()
  })

  test('completion via JobRegistryTopic respects tool timer delay', async () => {
    const system = await createPluginSystem()
    const start = Date.now()
    const mode: ToolMode = {
      kind: 'pending',
      eventually: { type: 'toolResult', result: { text: 'ok' } },
      delayMs: 50,
    }
    const tool = system.spawn('tool-delay', createTestTool(mode), { state: {
      mode, jobs: {},
    } }) as unknown as ActorRef<ToolMsg>

    const updatesSink: ToolFinalReply[] = []
    const updatesRef: ActorRef<ToolFinalReply> = {
      name: 'updates2', isAlive: () => true, send: (r) => { updatesSink.push(r) },
    }
    const caller = system.spawn('caller-delay', createCaller(tool, updatesRef))
    await tick()

    const sink: ActorRef<ToolFinalReply> = { name: 'sink', isAlive: () => true, send: () => {} }
    caller.send({ type: 'go', replyTo: sink })

    // After 20ms, completion should NOT have arrived (delay was 50ms)
    await tick(20)
    expect(updatesSink).toHaveLength(0)

    // After another 100ms, it should have
    await tick(100)
    expect(updatesSink).toHaveLength(1)
    const elapsed = Date.now() - start
    expect(elapsed).toBeGreaterThanOrEqual(45)
    await system.shutdown()
  })

  test('toolPending error completion via JobRegistryTopic', async () => {
    const system = await createPluginSystem()
    const mode: ToolMode = {
      kind: 'pending',
      eventually: { type: 'toolError', error: 'something went wrong' },
      delayMs: 20,
    }
    const tool = system.spawn('tool-err', createTestTool(mode), { state: {
      mode, jobs: {},
    } }) as unknown as ActorRef<ToolMsg>

    const updatesSink: ToolFinalReply[] = []
    const updatesRef: ActorRef<ToolFinalReply> = {
      name: 'updates3', isAlive: () => true, send: (r) => { updatesSink.push(r) },
    }
    const caller = system.spawn('caller-err', createCaller(tool, updatesRef))
    await tick()

    const immediate: ToolFinalReply[] = []
    const sink: ActorRef<ToolFinalReply> = { name: 'sink', isAlive: () => true, send: (r) => { immediate.push(r) } }
    caller.send({ type: 'go', replyTo: sink })
    await tick(80)

    expect(immediate).toHaveLength(1)
    expect(immediate[0]?.type).toBe('toolResult') // placeholder

    expect(updatesSink).toHaveLength(1)
    expect(updatesSink[0]).toEqual({ type: 'toolError', error: 'something went wrong' })
    await system.shutdown()
  })
})
