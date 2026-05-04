import { describe, test, expect } from 'bun:test'
import { createPluginSystem, invokeTool } from '../system/index.ts'
import type { ActorDef, ActorRef } from '../system/index.ts'
import { JobRegistryTopic } from '../types/tools.ts'
import type {
  JobLifecycleEvent,
  ToolFinalReply,
  ToolMsg,
  ToolReply,
} from '../types/tools.ts'

// ─── Helpers ───

const tick = (ms = 50) => Bun.sleep(ms)

// ─── Configurable test tool ───
//
// On `invoke`: replies according to its `mode`. Modes:
//   - 'syncResult' / 'syncError'                    → final reply immediately
//   - 'pendingThen(<n>, syncResult|syncError)'      → toolPending first, then
//                                                     after `n` jobStatus polls
//                                                     resolves with the kind
// `pollIntervalMsHint` is sent in the toolPending reply to drive the helper's
// polling cadence (kept short so tests stay fast).

type ToolMode =
  | { kind: 'syncResult'; result: string }
  | { kind: 'syncError';  error:  string }
  | { kind: 'pending'; eventually: ToolFinalReply; pollsUntilDone: number; intervalMs?: number; placeholder?: string }

type ToolState = {
  mode:        ToolMode
  jobs:        Record<string, { remaining: number; eventually: ToolFinalReply }>
  pollCounts:  Record<string, number>
}

const createTestTool = (mode: ToolMode): ActorDef<ToolMsg, ToolState> => ({
  handler: (state, msg) => {
    if (msg.type === 'invoke') {
      if (state.mode.kind === 'syncResult') {
        msg.replyTo.send({ type: 'toolResult', result: state.mode.result })
        return { state }
      }
      if (state.mode.kind === 'syncError') {
        msg.replyTo.send({ type: 'toolError', error: state.mode.error })
        return { state }
      }
      const jobId = `job-${Object.keys(state.jobs).length + 1}`
      msg.replyTo.send({
        type: 'toolPending',
        jobId,
        placeholderText: state.mode.placeholder,
        pollIntervalMs: state.mode.intervalMs,
      })
      return {
        state: {
          ...state,
          jobs: { ...state.jobs, [jobId]: { remaining: state.mode.pollsUntilDone, eventually: state.mode.eventually } },
        },
      }
    }
    // jobStatus
    const job = state.jobs[msg.jobId]
    if (!job) {
      msg.replyTo.send({ type: 'toolError', error: `unknown job ${msg.jobId}` })
      return { state }
    }
    const polls = (state.pollCounts[msg.jobId] ?? 0) + 1
    if (job.remaining > 0) {
      msg.replyTo.send({ type: 'toolPending', jobId: msg.jobId })
      return {
        state: {
          ...state,
          jobs:       { ...state.jobs, [msg.jobId]: { ...job, remaining: job.remaining - 1 } },
          pollCounts: { ...state.pollCounts, [msg.jobId]: polls },
        },
      }
    }
    msg.replyTo.send(job.eventually)
    const { [msg.jobId]: _drop, ...rest } = state.jobs
    return { state: { ...state, jobs: rest, pollCounts: { ...state.pollCounts, [msg.jobId]: polls } } }
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
  updatesTo: ActorRef<ToolFinalReply> | null,
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

    const tool = system.spawn('tool-sync-ok', createTestTool({ kind: 'syncResult', result: 'hi' }), {
      mode: { kind: 'syncResult', result: 'hi' }, jobs: {}, pollCounts: {},
    }) as unknown as ActorRef<ToolMsg>
    const caller = system.spawn('caller-sync-ok', createCaller(tool, null), null)
    await tick()

    const result: ToolFinalReply[] = []
    const sink: ActorRef<ToolFinalReply> = {
      name: 'sink', isAlive: () => true, send: (r) => { result.push(r) },
    }
    caller.send({ type: 'go', replyTo: sink })
    await tick(80)

    expect(result).toHaveLength(1)
    expect(result[0]).toEqual({ type: 'toolResult', result: 'hi' })
    expect(events).toHaveLength(0)
    await system.shutdown()
  })

  test('sync toolError: returns error directly, no events', async () => {
    const system = await createPluginSystem()
    const events: JobLifecycleEvent[] = []
    system.subscribe(JobRegistryTopic, (e) => { events.push(e) })

    const tool = system.spawn('tool-sync-err', createTestTool({ kind: 'syncError', error: 'nope' }), {
      mode: { kind: 'syncError', error: 'nope' }, jobs: {}, pollCounts: {},
    }) as unknown as ActorRef<ToolMsg>
    const caller = system.spawn('caller-sync-err', createCaller(tool, null), null)
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

    const mode: ToolMode = { kind: 'pending', eventually: { type: 'toolResult', result: 'done' }, pollsUntilDone: 0, intervalMs: 30 }
    const tool = system.spawn('tool-pending-no-cb', createTestTool(mode), {
      mode, jobs: {}, pollCounts: {},
    }) as unknown as ActorRef<ToolMsg>
    // Caller without onCompletion
    const caller = system.spawn('caller-no-cb', createCaller(tool, null), null)
    await tick()

    const immediate: ToolFinalReply[] = []
    const sink: ActorRef<ToolFinalReply> = { name: 'sink', isAlive: () => true, send: (r) => { immediate.push(r) } }
    caller.send({ type: 'go', replyTo: sink })
    await tick(80)

    expect(immediate).toHaveLength(1)
    expect(immediate[0]?.type).toBe('toolError')
    expect((immediate[0] as { type: 'toolError'; error: string }).error).toContain('does not support background completion')
    expect(events).toHaveLength(0)
    await system.shutdown()
  })

  test('toolPending with onCompletion: placeholder now, real result later, registry events emitted', async () => {
    const system = await createPluginSystem()
    const events: JobLifecycleEvent[] = []
    system.subscribe(JobRegistryTopic, (e) => { events.push(e) })

    const mode: ToolMode = {
      kind: 'pending',
      eventually:    { type: 'toolResult', result: 'finished work' },
      pollsUntilDone: 1,        // first jobStatus → still pending; second → done
      intervalMs:    20,
      placeholder:   'WORKING…',
    }
    const tool = system.spawn('tool-pending-cb', createTestTool(mode), {
      mode, jobs: {}, pollCounts: {},
    }) as unknown as ActorRef<ToolMsg>

    const updatesSink: ToolFinalReply[] = []
    const updatesRef: ActorRef<ToolFinalReply> = {
      name: 'updates', isAlive: () => true, send: (r) => { updatesSink.push(r) },
    }
    const caller = system.spawn('caller-cb', createCaller(tool, updatesRef), null)
    await tick()

    const immediate: ToolFinalReply[] = []
    const sink: ActorRef<ToolFinalReply> = { name: 'sink', isAlive: () => true, send: (r) => { immediate.push(r) } }
    caller.send({ type: 'go', replyTo: sink })
    await tick(30)

    // Immediate placeholder
    expect(immediate).toHaveLength(1)
    expect(immediate[0]).toEqual({ type: 'toolResult', result: 'WORKING…' })
    // Running event published
    const running = events.find(e => e.status === 'running')
    expect(running).toBeDefined()

    // Wait long enough for two polls (first → pending, second → done)
    await tick(120)

    expect(updatesSink).toHaveLength(1)
    expect(updatesSink[0]).toEqual({ type: 'toolResult', result: 'finished work' })

    // Cleared event published after completion
    const cleared = events.find(e => e.status === 'cleared')
    expect(cleared).toBeDefined()
    await system.shutdown()
  })

  test('custom pollIntervalMs from tool reply is honored', async () => {
    const system = await createPluginSystem()
    const start = Date.now()
    const mode: ToolMode = {
      kind: 'pending',
      eventually:    { type: 'toolResult', result: 'ok' },
      pollsUntilDone: 0,        // ready on first jobStatus
      intervalMs:    150,       // first poll after 150ms
    }
    const tool = system.spawn('tool-interval', createTestTool(mode), {
      mode, jobs: {}, pollCounts: {},
    }) as unknown as ActorRef<ToolMsg>

    const updatesSink: ToolFinalReply[] = []
    const updatesRef: ActorRef<ToolFinalReply> = {
      name: 'updates2', isAlive: () => true, send: (r) => { updatesSink.push(r) },
    }
    const caller = system.spawn('caller-interval', createCaller(tool, updatesRef), null)
    await tick()

    const sink: ActorRef<ToolFinalReply> = { name: 'sink', isAlive: () => true, send: () => {} }
    caller.send({ type: 'go', replyTo: sink })

    // After 100ms, completion should NOT have arrived (interval was 150)
    await tick(100)
    expect(updatesSink).toHaveLength(0)

    // After another 200ms, it should have
    await tick(200)
    expect(updatesSink).toHaveLength(1)
    const elapsed = Date.now() - start
    expect(elapsed).toBeGreaterThanOrEqual(140)  // honored the >=150ms wait
    await system.shutdown()
  })
})
