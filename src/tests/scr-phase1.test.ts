import { describe, test, expect } from 'bun:test'
import { AgentSystem, ask, invokeSCR, ResolutionCache, staticSource, onMessage } from '../system/index.ts'
import type { ActorDef, ActorRef } from '../system/index.ts'
import { SCRRegistrationTopic, UserBudgetTopic, UsageUpdateTopic } from '../types/scr.ts'
import type { SCRInvokeMsg, SCRReply, SCRDescriptor } from '../types/scr.ts'
import { requestStorage, createMessageRequest } from '../system/context/request.ts'
import { UserBudgetSupervisor } from '../plugins/observability/user-budget.ts'
import { SCRGCSweeper } from '../system/scr/gc-sweeper.ts'
import { MockPersistenceActor } from './mock-persistence.ts'
import { PersistenceProviderTopic } from '../types/persistence.ts'
import type { PersistenceMsg } from '../types/persistence.ts'

const tick = (ms = 50) => Bun.sleep(ms)

describe('SCR Phase 1: Registry, Cache, and invokeSCR Gating', () => {
  test('ResolutionCache syncs dynamic registrations and deregistrations', async () => {
    const system = await AgentSystem()
    await tick()

    const mockRef: ActorRef<any> = {
      name: 'system/mock-actor',
      send: () => {},
      isAlive: () => true,
    }

    const descriptor: SCRDescriptor = {
      urn: 'scr:leaf:test.hello',
      kind: 'leaf',
      description: 'Test capability',
      schema: {},
      target: mockRef,
    }

    // Publish registration
    system.publish(SCRRegistrationTopic, {
      type: 'register',
      descriptor,
    })
    await tick()

    const resolved = ResolutionCache.getDescriptor('scr:leaf:test.hello')
    expect(resolved).toBeDefined()
    expect(resolved?.urn).toBe('scr:leaf:test.hello')

    // Publish deregistration
    system.publish(SCRRegistrationTopic, {
      type: 'deregister',
      urn: 'scr:leaf:test.hello',
    })
    await tick()

    const resolvedAfter = ResolutionCache.getDescriptor('scr:leaf:test.hello')
    expect(resolvedAfter).toBeUndefined()

    await system.shutdown()
  })

  test('invokeSCR routes invocations to the resolved ActorRef', async () => {
    const system = await AgentSystem()
    await tick()

    type MockMsg = SCRInvokeMsg

    const mockActor: ActorDef<MockMsg, null> = {
      initialState: null,
      handler: onMessage({
        invoke: (state, msg) => {
          msg.replyTo.send({
            type: 'result',
            output: `hello ${msg.input}`,
          })
          return { state }
        },
      }),
    }

    const mockRef = system.spawn('hello-actor', mockActor)
    await tick()

    const descriptor: SCRDescriptor = {
      urn: 'scr:leaf:test.hello',
      kind: 'leaf',
      description: 'Test hello',
      schema: {},
      target: mockRef,
    }

    system.publish(SCRRegistrationTopic, {
      type: 'register',
      descriptor,
    })
    await tick()

    const reply = await invokeSCR('scr:leaf:test.hello', 'world')
    expect(reply.type).toBe('result')
    if (reply.type === 'result') {
      expect(reply.output).toBe('hello world')
    }

    await system.shutdown()
  })

  test('invokeSCR gates execution based on recursion depth', async () => {
    const system = await AgentSystem()
    await tick()

    const mockActor: ActorDef<SCRInvokeMsg, null> = {
      initialState: null,
      handler: onMessage({
        invoke: (state, msg) => {
          msg.replyTo.send({ type: 'result', output: 'ok' })
          return { state }
        },
      }),
    }
    const mockRef = system.spawn('hello-actor-depth', mockActor)
    await tick()

    const descriptor: SCRDescriptor = {
      urn: 'scr:leaf:test.hello',
      kind: 'leaf',
      description: 'Test hello',
      schema: {},
      target: mockRef,
    }

    system.publish(SCRRegistrationTopic, {
      type: 'register',
      descriptor,
    })
    await tick()

    // 1. Succeeded within depth (depth = 9, maxDepth = 10 -> nextDepth = 10)
    const validRequest = createMessageRequest({ depth: 9, maxDepth: 10 })
    const replyValid = await requestStorage.run(validRequest, () =>
      invokeSCR('scr:leaf:test.hello', 'world')
    )
    expect(replyValid.type).toBe('result')

    // 2. Fails if depth limit is exceeded (depth = 10, maxDepth = 10 -> nextDepth = 11)
    const invalidRequest = createMessageRequest({ depth: 10, maxDepth: 10 })
    const replyInvalid = await requestStorage.run(invalidRequest, () =>
      invokeSCR('scr:leaf:test.hello', 'world')
    )
    expect(replyInvalid.type).toBe('error')
    if (replyInvalid.type === 'error') {
      expect(replyInvalid.error).toContain('recursion depth')
    }

    await system.shutdown()
  })

  test('invokeSCR gates execution based on user budget limits', async () => {
    const system = await AgentSystem()
    await tick()

    const mockActor: ActorDef<SCRInvokeMsg, null> = {
      initialState: null,
      handler: onMessage({
        invoke: (state, msg) => {
          msg.replyTo.send({ type: 'result', output: 'ok' })
          return { state }
        },
      }),
    }
    const mockRef = system.spawn('hello-actor-budget', mockActor)
    await tick()

    const descriptor: SCRDescriptor = {
      urn: 'scr:leaf:test.hello',
      kind: 'leaf',
      description: 'Test hello',
      schema: {},
      target: mockRef,
    }

    system.publish(SCRRegistrationTopic, {
      type: 'register',
      descriptor,
    })

    // Publish budget under limits (should pass)
    system.publish(UserBudgetTopic, {
      userId: 'user-1',
      tokensSpent: 50,
      costSpentUsd: 0.10,
      maxTokens: 100,
      maxCostUsd: 1.00,
    })
    await tick()

    const reqUnder = createMessageRequest({ userId: 'user-1' })
    const replyUnder = await requestStorage.run(reqUnder, () =>
      invokeSCR('scr:leaf:test.hello', 'world')
    )
    expect(replyUnder.type).toBe('result')

    // Publish budget exceeding token limit (should fail)
    system.publish(UserBudgetTopic, {
      userId: 'user-1',
      tokensSpent: 120,
      costSpentUsd: 0.10,
      maxTokens: 100,
      maxCostUsd: 1.00,
    })
    await tick()

    const replyTokenExceeded = await requestStorage.run(reqUnder, () =>
      invokeSCR('scr:leaf:test.hello', 'world')
    )
    expect(replyTokenExceeded.type).toBe('error')
    if (replyTokenExceeded.type === 'error') {
      expect(replyTokenExceeded.error).toContain('budget exceeded')
      expect(replyTokenExceeded.error).toContain('token limit')
    }

    await system.shutdown()
  })

  test('invokeSCR gates execution based on permission context', async () => {
    const system = await AgentSystem()
    await tick()

    const mockActor: ActorDef<SCRInvokeMsg, null> = {
      initialState: null,
      handler: onMessage({
        invoke: (state, msg) => {
          msg.replyTo.send({ type: 'result', output: 'ok' })
          return { state }
        },
      }),
    }
    const mockRef = system.spawn('hello-actor-permission', mockActor)
    await tick()

    const descriptor: SCRDescriptor = {
      urn: 'scr:leaf:test.hello',
      kind: 'leaf',
      description: 'Test hello',
      schema: {},
      target: mockRef,
    }

    system.publish(SCRRegistrationTopic, {
      type: 'register',
      descriptor,
    })
    await tick()

    // 1. Authorized with wildcard grant
    const reqWildcard = createMessageRequest({ permission: { grants: ['*'] } })
    const replyWildcard = await requestStorage.run(reqWildcard, () =>
      invokeSCR('scr:leaf:test.hello', 'world')
    )
    expect(replyWildcard.type).toBe('result')

    // 2. Authorized with legacy format grant (test_hello)
    const reqLegacy = createMessageRequest({ permission: { grants: ['test_hello'] } })
    const replyLegacy = await requestStorage.run(reqLegacy, () =>
      invokeSCR('scr:leaf:test.hello', 'world')
    )
    expect(replyLegacy.type).toBe('result')

    // 3. Unauthorized with unrelated grants
    const reqUnauthorized = createMessageRequest({ permission: { grants: ['tools_web_search'] } })
    const replyUnauthorized = await requestStorage.run(reqUnauthorized, () =>
      invokeSCR('scr:leaf:test.hello', 'world')
    )
    expect(replyUnauthorized.type).toBe('error')
    if (replyUnauthorized.type === 'error') {
      expect(replyUnauthorized.error).toContain('Unauthorized')
    }

    await system.shutdown()
  })

  test('UserBudgetSupervisor spawns UserBudgetActor and accumulates usage events', async () => {
    const source = staticSource({
      plugins: [MockPersistenceActor()],
    })
    const system = await AgentSystem({ source })
    await tick()

    system.spawn('user-budget-supervisor', UserBudgetSupervisor())
    await tick()

    // Publish usage update deltas
    system.publish(UsageUpdateTopic, {
      userId: 'user-2',
      tokens: 15,
      costUsd: 0.01,
    })
    await tick()

    let budget = ResolutionCache.getBudget('user-2')
    expect(budget).toBeDefined()
    expect(budget?.tokensSpent).toBe(15)
    expect(budget?.costSpentUsd).toBe(0.01)

    // Accumulate further updates
    system.publish(UsageUpdateTopic, {
      userId: 'user-2',
      tokens: 35,
      costUsd: 0.04,
    })
    await tick()

    budget = ResolutionCache.getBudget('user-2')
    expect(budget?.tokensSpent).toBe(50)
    expect(budget?.costSpentUsd).toBe(0.05)

    await system.shutdown()
  })

  test('SCRGCSweeper deletes stale and orphaned runner keys from KV store', async () => {
    const source = staticSource({
      plugins: [MockPersistenceActor()],
    })
    const system = await AgentSystem({ source })
    await tick()

    const provider = system.spawn('gc-sweeper', SCRGCSweeper())
    await tick()

    // Get the mock-persistence actor ref
    let persistenceRef: ActorRef<PersistenceMsg> | null = null
    system.subscribe(PersistenceProviderTopic, (e) => {
      if (e.ref) persistenceRef = e.ref
    })
    await tick()

    expect(persistenceRef).not.toBeNull()

    // Insert keys:
    // 1. Stale key (lastUpdated < bootTime)
    const oldTime = Date.now() - 5000
    await ask(persistenceRef!, (replyTo) => ({
      type: 'kv.put' as const,
      key: 'scr.run.stale-runner',
      value: { timestamp: oldTime },
      replyTo,
    }))

    // 2. Active key (lastUpdated > bootTime)
    const newTime = Date.now() + 5000
    await ask(persistenceRef!, (replyTo) => ({
      type: 'kv.put' as const,
      key: 'scr.run.active-runner',
      value: { timestamp: newTime },
      replyTo,
    }))

    // Trigger sweep
    provider.send({ type: 'sweep' })
    await tick(300)

    // Verify key deletion: stale-runner should be deleted, active-runner should remain
    const resStale = await ask<PersistenceMsg, any>(persistenceRef!, (replyTo) => ({
      type: 'kv.get' as const,
      key: 'scr.run.stale-runner',
      replyTo,
    }))
    expect(resStale.ok).toBe(false)

    const resActive = await ask<PersistenceMsg, any>(persistenceRef!, (replyTo) => ({
      type: 'kv.get' as const,
      key: 'scr.run.active-runner',
      replyTo,
    }))
    expect(resActive.ok).toBe(true)

    await system.shutdown()
  })
})
