import { describe, test, expect, afterEach } from 'bun:test'
import { AgentSystem, invokeSCR, ask, staticSource, LogTopic } from '../system/index.ts'
import type { ActorDef, ActorRef } from '../system/index.ts'
import { SCRRegistrationTopic } from '../types/scr.ts'
import { JobRegistryTopic } from '../types/tools.ts'
import { PersistenceProviderTopic } from '../types/persistence.ts'
import type { PList, PResult } from '../types/persistence.ts'
import { MockPersistenceActor } from './mock-persistence.ts'
import { ResolutionCache } from '../system/scr/cache.ts'
import workflowsPlugin from '../plugins/workflows/workflows.plugin.ts'

const tick = (ms = 100) => Bun.sleep(ms)

const FakeTaskTool = (): ActorDef<any, null> => ({
  initialState: null,
  handler: (state, msg) => {
    if (msg.type === 'invoke') {
      const args = msg.input as any
      const arg1 = args?.arg1 || 'none'
      msg.replyTo.send({
        type: 'result',
        output: { resultVal: `processed ${arg1}` }
      })
    }
    return { state }
  }
})

const LongRunningTaskTool = (): ActorDef<any, { jobId: string }> => ({
  initialState: () => ({ jobId: 'job-123' }),
  handler: (state, msg) => {
    if (msg.type === 'invoke') {
      msg.replyTo.send({
        type: 'pending',
        jobId: state.jobId,
        placeholderText: 'Waiting for async processing'
      })
    }
    return { state }
  }
})

describe('SCR Phase 4: Graph (Workflow) & Operator Integration', () => {
  afterEach(() => {
    ResolutionCache.clear()
  })

  test('WorkflowManager and SCRWorkflowRunner execute workflow via invokeSCR', async () => {
    const system = await AgentSystem({
      source: staticSource({
        plugins: [
          MockPersistenceActor(),
          workflowsPlugin,
        ],
        config: {
          workflows: {
            agent: {
              model: 'test-model',
              maxToolLoops: 1
            }
          }
        }
      })
    })

    system.subscribe(LogTopic, (e: any) => {
      console.log(`[LOG] [${e.level}] ${e.source}: ${e.message}`)
      if (e.data?.error) {
        console.error("ACTOR ERROR STACK:", e.data.error)
      }
    })

    await tick()

    let persistenceRef: ActorRef<any> | null = null
    system.subscribe(PersistenceProviderTopic, (e: any) => {
      if (e?.ref) persistenceRef = e.ref
    })

    await tick()
    expect(persistenceRef).toBeDefined()

    const workflowDoc = {
      id: 'workflow-test-1',
      userId: 'system',
      title: 'Workflow Integration Test',
      goal: 'Integrate and test workflow execution',
      context: 'Test context',
      createdAt: '2026-08-13T12:00:00Z',
      inputs: {
        arg1: { type: 'string', required: true }
      },
      outputs: {
        resultVal: { type: 'string' }
      },
      tasks: [
        {
          id: 'task-1',
          name: 'Task 1',
          description: 'A simple task',
          validationCriteria: 'Returns outputs matching schema',
          dependencies: [],
          agentMode: 'scr:leaf:tools.fake_task_tool'
        }
      ]
    }

    await ask(persistenceRef!, (replyTo) => ({
      type: 'doc.put',
      collection: 'workflows',
      docId: 'workflow-test-1.json',
      content: JSON.stringify(workflowDoc),
      replyTo,
    }))

    // Re-publish persistence provider to trigger workflow scanning
    system.publish(PersistenceProviderTopic, { ref: persistenceRef })

    await tick(200)

    const desc = ResolutionCache.getDescriptor('scr:graph:workflows.workflow-test-1')
    expect(desc).toBeDefined()
    expect(desc?.kind).toBe('graph')
    expect(desc?.target.name).toContain('workflows/manager')

    const toolRef = system.spawn('fake-task-tool', FakeTaskTool())
    system.publish(SCRRegistrationTopic, {
      type: 'register',
      descriptor: {
        urn: 'scr:leaf:tools.fake_task_tool',
        kind: 'leaf',
        description: 'Fake task tool',
        schema: {
          inputSchema: {},
          outputSchema: {},
        },
        target: toolRef,
      }
    })

    await tick()

    const reply = await invokeSCR('scr:graph:workflows.workflow-test-1', { arg1: 'hello-world' })
    console.log("REPLY 1:", JSON.stringify(reply, null, 2))
    expect(reply.type).toBe('result')
    if (reply.type === 'result') {
      expect((reply.output as any).resultVal).toBe('processed hello-world')
    }

    await system.shutdown()
  })

  test('Workflow run suspends on pending tool and resumes on JobRegistry completion', async () => {
    const system = await AgentSystem({
      source: staticSource({
        plugins: [
          MockPersistenceActor(),
          workflowsPlugin,
        ],
        config: {
          workflows: {
            agent: {
              model: 'test-model',
              maxToolLoops: 1
            }
          }
        }
      })
    })

    system.subscribe(LogTopic, (e: any) => {
      console.log(`[LOG] [${e.level}] ${e.source}: ${e.message}`)
      if (e.data?.error) {
        console.error("ACTOR ERROR STACK:", e.data.error)
      }
    })

    await tick()

    let persistenceRef: ActorRef<any> | null = null
    system.subscribe(PersistenceProviderTopic, (e: any) => {
      if (e?.ref) persistenceRef = e.ref
    })

    await tick()

    const workflowDoc = {
      id: 'workflow-test-2',
      userId: 'system',
      title: 'Workflow Resumption Test',
      goal: 'Integrate and test workflow resumption',
      context: 'Test context',
      createdAt: '2026-08-13T12:00:00Z',
      inputs: {
        arg1: { type: 'string', required: true }
      },
      outputs: {
        resultVal: { type: 'string' }
      },
      tasks: [
        {
          id: 'task-1',
          name: 'Task 1',
          description: 'A long running task',
          validationCriteria: 'Returns outputs matching schema',
          dependencies: [],
          agentMode: 'scr:leaf:tools.long_running_tool'
        }
      ]
    }

    await ask(persistenceRef!, (replyTo) => ({
      type: 'doc.put',
      collection: 'workflows',
      docId: 'workflow-test-2.json',
      content: JSON.stringify(workflowDoc),
      replyTo,
    }))

    // Re-publish persistence provider to trigger workflow scanning
    system.publish(PersistenceProviderTopic, { ref: persistenceRef })

    await tick(200)

    const longRunningToolRef = system.spawn('long-running-tool', LongRunningTaskTool())
    system.publish(SCRRegistrationTopic, {
      type: 'register',
      descriptor: {
        urn: 'scr:leaf:tools.long_running_tool',
        kind: 'leaf',
        description: 'Long running task tool',
        schema: {
          inputSchema: {},
          outputSchema: {},
        },
        target: longRunningToolRef,
      }
    })

    await tick()

    const reply = await invokeSCR('scr:graph:workflows.workflow-test-2', { arg1: 'hello-async' })
    console.log("REPLY 2:", JSON.stringify(reply, null, 2))
    expect(reply.type).toBe('pending')
    if (reply.type === 'pending') {
      expect(reply.jobId).toBe('job-123')
    }

    // Wait for the runner actor to fully stop and unregister from the parent's children map
    await tick(100)

    system.publish(JobRegistryTopic, {
      jobId: 'job-123',
      status: 'completed',
      result: {
        text: 'Job finished successfully',
        outputs: { resultVal: 'async success value' }
      } as any
    })

    await tick(300)

    const runList = await ask<any, PList>(persistenceRef!, (replyTo) => ({
      type: 'doc.list',
      collection: 'workflow-runs',
      replyTo,
    }))

    expect(runList.ok).toBe(true)
    let docId = ''
    if (runList.ok) {
      expect(runList.keys.length).toBe(1)
      docId = runList.keys[0] ?? ''
    }

    const runDoc = await ask<any, PResult<string>>(persistenceRef!, (replyTo) => ({
      type: 'doc.get',
      collection: 'workflow-runs',
      docId,
      replyTo,
    }))
    expect(runDoc.ok).toBe(true)
    let runState: any = {}
    if (runDoc.ok) {
      runState = JSON.parse(runDoc.data ?? '{}')
    }
    console.log("RUN STATE EVENTS:", JSON.stringify(runState.events, null, 2))
    expect(runState.status).toBe('completed')
    expect(runState.outputs.resultVal).toBe('async success value')

    await system.shutdown()
  })

  test('Sequence and Parallel operators execute child URNs', async () => {
    const system = await AgentSystem({
      source: staticSource({
        plugins: [
          MockPersistenceActor(),
          workflowsPlugin,
        ],
        config: {
          workflows: {
            agent: {
              model: 'test-model',
              maxToolLoops: 1
            }
          }
        }
      })
    })

    await tick()

    const DoubleTool = (): ActorDef<any, null> => ({
      initialState: null,
      handler: (state, msg) => {
        if (msg.type === 'invoke') {
          const args = msg.input as any
          const value = args?.value || 0
          msg.replyTo.send({
            type: 'result',
            output: { value: value * 2 }
          })
        }
        return { state }
      }
    })

    const toolRef = system.spawn('double-tool', DoubleTool())
    system.publish(SCRRegistrationTopic, {
      type: 'register',
      descriptor: {
        urn: 'scr:leaf:tools.double_tool',
        kind: 'leaf',
        description: 'Double tool',
        schema: {
          inputSchema: {},
          outputSchema: {},
        },
        target: toolRef,
      }
    })

    await tick()

    // Test Sequence: double 5, then double the result (which defaults to passing previous result if input is omitted)
    const seqReply = await invokeSCR('scr:operator:workflows.sequence', {
      operands: [
        { urn: 'scr:leaf:tools.double_tool', input: { value: 5 } },
        { urn: 'scr:leaf:tools.double_tool' } // Should feed output of first { value: 10 } into second
      ]
    })

    expect(seqReply.type).toBe('result')
    if (seqReply.type === 'result') {
      expect((seqReply.output as any).lastResult.value).toBe(20)
    }

    // Test Parallel: double 10 and 20 concurrently
    const parReply = await invokeSCR('scr:operator:workflows.parallel', {
      operands: [
        { urn: 'scr:leaf:tools.double_tool', input: { value: 10 } },
        { urn: 'scr:leaf:tools.double_tool', input: { value: 20 } }
      ]
    })

    expect(parReply.type).toBe('result')
    if (parReply.type === 'result') {
      const results = (parReply.output as any).results
      expect(results[0].value).toBe(20)
      expect(results[1].value).toBe(40)
    }

    await system.shutdown()
  })

  test('Map and Branch operators execute child URNs', async () => {
    const system = await AgentSystem({
      source: staticSource({
        plugins: [
          MockPersistenceActor(),
          workflowsPlugin,
        ],
        config: {
          workflows: {
            agent: {
              model: 'test-model',
              maxToolLoops: 1
            }
          }
        }
      })
    })

    await tick()

    const DoubleTool = (): ActorDef<any, null> => ({
      initialState: null,
      handler: (state, msg) => {
        if (msg.type === 'invoke') {
          const args = msg.input as any
          const value = args?.value || 0
          msg.replyTo.send({
            type: 'result',
            output: { value: value * 2 }
          })
        }
        return { state }
      }
    })

    const ConditionTool = (): ActorDef<any, null> => ({
      initialState: null,
      handler: (state, msg) => {
        if (msg.type === 'invoke') {
          const args = msg.input as any
          const check = args?.check || 'none'
          msg.replyTo.send({
            type: 'result',
            output: { branch: check === 'go' ? 'branchA' : 'branchB' }
          })
        }
        return { state }
      }
    })

    const toolRef = system.spawn('double-tool', DoubleTool())
    const condRef = system.spawn('condition-tool', ConditionTool())

    system.publish(SCRRegistrationTopic, {
      type: 'register',
      descriptor: {
        urn: 'scr:leaf:tools.double_tool',
        kind: 'leaf',
        description: 'Double tool',
        schema: {
          inputSchema: {},
          outputSchema: {},
        },
        target: toolRef,
      }
    })

    system.publish(SCRRegistrationTopic, {
      type: 'register',
      descriptor: {
        urn: 'scr:leaf:tools.condition_tool',
        kind: 'leaf',
        description: 'Condition tool',
        schema: {
          inputSchema: {},
          outputSchema: {},
        },
        target: condRef,
      }
    })

    await tick()

    // Test Map (Parallel)
    const mapReply = await invokeSCR('scr:operator:workflows.map', {
      urn: 'scr:leaf:tools.double_tool',
      items: [{ value: 1 }, { value: 2 }, { value: 3 }]
    })

    expect(mapReply.type).toBe('result')
    if (mapReply.type === 'result') {
      const results = (mapReply.output as any).results
      expect(results[0].value).toBe(2)
      expect(results[1].value).toBe(4)
      expect(results[2].value).toBe(6)
    }

    // Test Map (Sequential)
    const mapSeqReply = await invokeSCR('scr:operator:workflows.map', {
      urn: 'scr:leaf:tools.double_tool',
      items: [{ value: 4 }, { value: 5 }],
      concurrency: 'sequence'
    })

    expect(mapSeqReply.type).toBe('result')
    if (mapSeqReply.type === 'result') {
      const results = (mapSeqReply.output as any).results
      expect(results[0].value).toBe(8)
      expect(results[1].value).toBe(10)
    }

    // Test Branch (Simple Equality)
    const branchEqReply = await invokeSCR('scr:operator:workflows.branch', {
      value: 'hello',
      expected: 'hello',
      branches: {
        true: { urn: 'scr:leaf:tools.double_tool', input: { value: 50 } },
        false: { urn: 'scr:leaf:tools.double_tool', input: { value: 100 } }
      }
    })

    expect(branchEqReply.type).toBe('result')
    if (branchEqReply.type === 'result') {
      expect((branchEqReply.output as any).value).toBe(100)
    }

    // Test Branch (Condition URN)
    const branchUrnReply = await invokeSCR('scr:operator:workflows.branch', {
      conditionUrn: 'scr:leaf:tools.condition_tool',
      conditionInput: { check: 'go' },
      branches: {
        branchA: { urn: 'scr:leaf:tools.double_tool', input: { value: 7 } },
        branchB: { urn: 'scr:leaf:tools.double_tool', input: { value: 9 } }
      }
    })

    expect(branchUrnReply.type).toBe('result')
    if (branchUrnReply.type === 'result') {
      expect((branchUrnReply.output as any).value).toBe(14)
    }

    await system.shutdown()
  })

  test('Retry and Fallback operators execute child URNs with recovery', async () => {
    const system = await AgentSystem({
      source: staticSource({
        plugins: [
          MockPersistenceActor(),
          workflowsPlugin,
        ],
        config: {
          workflows: {
            agent: {
              model: 'test-model',
              maxToolLoops: 1
            }
          }
        }
      })
    })

    await tick()

    let failingAttempts = 0
    const FailingTool = (): ActorDef<any, null> => ({
      initialState: null,
      handler: (state, msg) => {
        if (msg.type === 'invoke') {
          failingAttempts++
          if (failingAttempts < 3) {
            msg.replyTo.send({
              type: 'error',
              error: `Failed attempt ${failingAttempts}`
            })
          } else {
            msg.replyTo.send({
              type: 'result',
              output: { val: 'success after failures' }
            })
          }
        }
        return { state }
      }
    })

    const SuccessTool = (): ActorDef<any, null> => ({
      initialState: null,
      handler: (state, msg) => {
        if (msg.type === 'invoke') {
          msg.replyTo.send({
            type: 'result',
            output: { val: 'fallback success' }
          })
        }
        return { state }
      }
    })

    const failRef = system.spawn('failing-tool', FailingTool())
    const succRef = system.spawn('success-tool', SuccessTool())

    system.publish(SCRRegistrationTopic, {
      type: 'register',
      descriptor: {
        urn: 'scr:leaf:tools.failing_tool',
        kind: 'leaf',
        description: 'Failing tool',
        schema: {
          inputSchema: {},
          outputSchema: {},
        },
        target: failRef,
      }
    })

    system.publish(SCRRegistrationTopic, {
      type: 'register',
      descriptor: {
        urn: 'scr:leaf:tools.success_tool',
        kind: 'leaf',
        description: 'Success tool',
        schema: {
          inputSchema: {},
          outputSchema: {},
        },
        target: succRef,
      }
    })

    await tick()

    // Test Retry: should fail twice and succeed on 3rd attempt
    const retryReply = await invokeSCR('scr:operator:workflows.retry', {
      urn: 'scr:leaf:tools.failing_tool',
      input: {},
      maxAttempts: 3,
      backoffMs: 10
    })

    expect(retryReply.type).toBe('result')
    if (retryReply.type === 'result') {
      expect((retryReply.output as any).val).toBe('success after failures')
    }

    // Test Fallback: failing_tool now succeeded on 3rd try, so reset attempts to fail again
    failingAttempts = 0
    const fallbackReply = await invokeSCR('scr:operator:workflows.fallback', {
      operands: [
        { urn: 'scr:leaf:tools.failing_tool', input: {} }, // fails on first try
        { urn: 'scr:leaf:tools.success_tool', input: {} } // succeeds
      ]
    })

    expect(fallbackReply.type).toBe('result')
    if (fallbackReply.type === 'result') {
      expect((fallbackReply.output as any).val).toBe('fallback success')
    }

    await system.shutdown()
  })

  test('Operator run suspends on pending child and resumes on JobRegistry completion', async () => {
    const system = await AgentSystem({
      source: staticSource({
        plugins: [
          MockPersistenceActor(),
          workflowsPlugin,
        ],
        config: {
          workflows: {
            agent: {
              model: 'test-model',
              maxToolLoops: 1
            }
          }
        }
      })
    })

    await tick()

    let persistenceRef: ActorRef<any> | null = null
    system.subscribe(PersistenceProviderTopic, (e: any) => {
      if (e?.ref) persistenceRef = e.ref
    })

    await tick()

    const longRunningToolRef = system.spawn('long-running-tool', LongRunningTaskTool())
    system.publish(SCRRegistrationTopic, {
      type: 'register',
      descriptor: {
        urn: 'scr:leaf:tools.long_running_tool',
        kind: 'leaf',
        description: 'Long running task tool',
        schema: {
          inputSchema: {},
          outputSchema: {},
        },
        target: longRunningToolRef,
      }
    })

    await tick()

    // Invoke sequence containing the long running tool
    const reply = await invokeSCR('scr:operator:workflows.sequence', {
      operands: [
        { urn: 'scr:leaf:tools.long_running_tool', input: {} }
      ]
    })

    expect(reply.type).toBe('pending')
    if (reply.type === 'pending') {
      expect(reply.jobId).toBe('job-123')
    }

    await tick(100)

    // Complete the pending job
    system.publish(JobRegistryTopic, {
      jobId: 'job-123',
      status: 'completed',
      result: {
        text: 'Job finished successfully',
        outputs: { resultVal: 'async success value' }
      } as any
    })

    // Give it time to resume and complete
    await tick(300)

    // Check that persistence has cleaned up the operator runner state
    const runList = await ask<any, PList>(persistenceRef!, (replyTo) => ({
      type: 'doc.list',
      collection: 'workflow-runs', // wait, does operator run save to workflow-runs? No, it deletes kv scr.run.${runId} directly
      replyTo,
    }))

    // Check directly in persistence KV store if `scr.run.*` exists
    const listKeys = await ask<any, PList>(persistenceRef!, (replyTo) => ({
      type: 'kv.list',
      replyTo,
    }))

    expect(listKeys.ok).toBe(true)
    if (listKeys.ok) {
      const activeRuns = listKeys.keys.filter((k: string) => k.startsWith('scr.run.'))
      expect(activeRuns.length).toBe(0) // should be cleaned up!
    }

    await system.shutdown()
  })

  test('WorkflowManager WebSocket Frame Ingress Routing handles workflow requests (Task 5.1)', async () => {
    const { HttpWsFrameTopic, OutboundUserMessageTopic } = await import('../types/events.ts')
    const { WorkflowManager } = await import('../plugins/workflows/workflow-manager.ts')

    const system = await AgentSystem({
      source: staticSource({
        plugins: [
          MockPersistenceActor(),
        ],
        config: {}
      })
    })

    const events: any[] = []
    system.subscribe(OutboundUserMessageTopic, (e: any) => {
      events.push(e)
    })

    await tick()

    let persistenceRef: ActorRef<any> | null = null
    system.subscribe(PersistenceProviderTopic, (e: any) => {
      if (e?.ref) persistenceRef = e.ref
    })

    await tick()
    expect(persistenceRef).toBeDefined()

    // Spawn WorkflowManager directly
    const manager = system.spawn('workflow-manager-test', WorkflowManager({ model: 'test-model', maxToolLoops: 1 }))
    system.publish(PersistenceProviderTopic, { ref: persistenceRef })

    await tick(100)

    const workflowDoc = {
      id: 'workflow-ws-test',
      userId: 'u1',
      title: 'Workflow WS Test',
      goal: 'Test WS ingress',
      context: 'Test context',
      createdAt: '2026-08-13T12:00:00Z',
      inputs: {},
      outputs: {},
      tasks: []
    }

    // Seed workflow
    await ask(persistenceRef!, (replyTo) => ({
      type: 'doc.put',
      collection: 'workflows',
      docId: 'workflow-ws-test.json',
      content: JSON.stringify(workflowDoc),
      replyTo,
    }))

    await tick(100)

    // 1. Send workflow.list.request
    system.publish(HttpWsFrameTopic, {
      clientId: 'c1',
      userId: 'u1',
      roles: [],
      frame: { type: 'workflow.list.request' }
    })

    await tick(200)

    expect(events.length).toBeGreaterThanOrEqual(1)
    const listRes = JSON.parse(events[events.length - 1].text)
    expect(listRes.type).toBe('workflows.list')
    expect(listRes.workflows[0]).toMatchObject({ id: 'workflow-ws-test', taskCount: 0 })

    // 2. Send workflow.graph.request
    system.publish(HttpWsFrameTopic, {
      clientId: 'c1',
      userId: 'u1',
      roles: [],
      frame: { type: 'workflow.graph.request', workflowId: 'workflow-ws-test' }
    })

    await tick(200)

    const graphRes = JSON.parse(events[events.length - 1].text)
    expect(graphRes.type).toBe('workflow.graph')
    expect(graphRes.workflowId).toBe('workflow-ws-test')

    await system.shutdown()
  })

  test('WorkflowManager HTTP Ingress Routing serves workflow artifacts (Task 5.2)', async () => {
    const { WorkflowManager } = await import('../plugins/workflows/workflow-manager.ts')

    const system = await AgentSystem({
      source: staticSource({
        plugins: [
          MockPersistenceActor(),
        ],
        config: {}
      })
    })

    await tick()

    let persistenceRef: ActorRef<any> | null = null
    system.subscribe(PersistenceProviderTopic, (e: any) => {
      if (e?.ref) persistenceRef = e.ref
    })

    await tick()
    expect(persistenceRef).toBeDefined()

    // Spawn WorkflowManager directly
    const manager = system.spawn('workflow-manager-http-test', WorkflowManager({ model: 'test-model', maxToolLoops: 1 }))
    system.publish(PersistenceProviderTopic, { ref: persistenceRef })

    await tick(100)

    // Put a mock artifact into persistence object store
    const contentStream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('<h1>Report</h1>'))
        controller.close()
      }
    })

    await ask(persistenceRef!, (replyTo) => ({
      type: 'obj.putStream',
      bucket: 'workflow-runs',
      key: 'run-1/report.html',
      stream: contentStream,
      meta: { contentType: 'text/html' },
      replyTo,
    }))

    // Send HTTP Request to WorkflowManager
    const resMsg = await ask<any, any>(
      manager,
      replyTo => ({
        type: 'http.request',
        request: {
          method: 'GET',
          url: '/artifact?key=workflow-runs/run-1/report.html',
          headers: {},
          body: null,
        },
        replyTo,
      }),
      undefined,
      { userId: 'anonymous', roles: [] }
    )

    expect(resMsg.response.status).toBe(200)
    expect(resMsg.response.headers['Content-Type']).toBe('text/html')
    const text = await new Response(resMsg.response.body as ReadableStream).text()
    expect(text).toBe('<h1>Report</h1>')

    await system.shutdown()
  })
})
