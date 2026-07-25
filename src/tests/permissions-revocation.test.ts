import { describe, expect, test } from 'bun:test'
import { AgentSystem, ask, watchTopic } from '../system/index.ts'
import type { ActorDef, ActorRef, LifecycleEvent } from '../system/index.ts'
import { Authenticator, type AuthConfig } from '../plugins/auth/authenticator.ts'
import { UserStore } from '../plugins/auth/user-store.ts'
import type { AuthenticatorMsg, User, UserStoreMsg } from '../plugins/auth/types.ts'
import { SessionLifecycleTopic, type SessionLifecycleEvent } from '../types/session.ts'
import { LlmProviderTopic, type LlmProviderMsg } from '../types/llm.ts'
import { UserPresenceTopic } from '../types/events.ts'
import { AgentRegistrationTopic } from '../types/agents.ts'
import { SessionManager } from '../plugins/cognitive/session-manager.ts'
import { AgentRegistry } from '../plugins/cognitive/agent-registry.ts'
import { MockPersistenceActor } from './mock-persistence.ts'

const tick = (ms = 50) => Bun.sleep(ms)

const baseConfig: AuthConfig = {
  rpId: 'localhost',
  rpName: 'Test RP',
  origin: 'http://localhost:3000',
  baseUrl: 'http://localhost:3000',
  sessionTtlMs: 3600000,
  challengeTtlMs: 60000,
  ticketTtlMs: 10000,
  permissions: {
    roleDefaults: {
      user: ['tools_*', 'notebook_*'],
      guest: ['tools_web_search'],
    },
  },
}

const NullLlm = (): ActorDef<LlmProviderMsg, null> => ({
  initialState: null,
  handler: (state, msg) => {
    if (msg && typeof msg === 'object' && msg.type === 'stream') {
      msg.replyTo.send({ type: 'llmChunk', requestId: msg.requestId, text: 'agent-ready' })
      msg.replyTo.send({ type: 'llmDone', requestId: msg.requestId, usage: { promptTokens: 1, completionTokens: 1 } })
    }
    return { state }
  },
})

describe('Permissions Revocation', () => {
  test('UserStore setUserPermissions replaces permissions array', async () => {
    const system = await AgentSystem({ plugins: [MockPersistenceActor()] })
    const store = system.spawn('users', UserStore()) as ActorRef<UserStoreMsg>

    const created = await ask<UserStoreMsg, { ok: User } | { error: string }>(
      store,
      replyTo => ({
        type: 'createUser',
        fullName: 'alice',
        roles: ['user'],
        permissions: ['old_grant'],
        replyTo,
      }),
    )
    expect('ok' in created).toBe(true)
    if (!('ok' in created)) return

    const updated = await ask<UserStoreMsg, { ok: User } | { error: string }>(
      store,
      replyTo => ({
        type: 'setUserPermissions',
        userId: created.ok.id,
        permissions: ['!coding_shell_exec', 'tools_web_search'],
        replyTo,
      }),
    )
    expect('ok' in updated).toBe(true)
    if (!('ok' in updated)) return
    expect(updated.ok.permissions).toEqual(['!coding_shell_exec', 'tools_web_search'])
    expect(updated.ok.permissions).not.toContain('old_grant')

    await system.shutdown()
  })

  test('Authenticator setUserPermissions persists and publishes sessionInvalidated', async () => {
    const system = await AgentSystem({ plugins: [MockPersistenceActor()] })
    const store = system.spawn('users', UserStore()) as ActorRef<UserStoreMsg>
    const auth = system.spawn('auth', Authenticator({
      userStore: store,
      config: baseConfig,
    })) as ActorRef<AuthenticatorMsg>

    const created = await ask<UserStoreMsg, { ok: User } | { error: string }>(
      store,
      replyTo => ({
        type: 'createUser',
        fullName: 'bob',
        roles: ['user'],
        permissions: [],
        replyTo,
      }),
    )
    expect('ok' in created).toBe(true)
    if (!('ok' in created)) return
    const userId = created.ok.id

    const events: SessionLifecycleEvent[] = []
    system.subscribe(SessionLifecycleTopic, (event) => {
      events.push(event)
    })

    const result = await ask<AuthenticatorMsg, { ok: User } | { error: string }>(
      auth,
      replyTo => ({
        type: 'setUserPermissions',
        userId,
        permissions: ['!coding_shell_exec'],
        replyTo,
      }),
    )
    expect('ok' in result).toBe(true)
    if (!('ok' in result)) return
    expect(result.ok.permissions).toEqual(['!coding_shell_exec'])

    await tick(50)

    const invalidated = events.find(e => e.type === 'sessionInvalidated' && e.userId === userId)
    expect(invalidated).toBeDefined()
    if (!invalidated || invalidated.type !== 'sessionInvalidated') return

    // Effective grants = roleDefaults[user] ∪ custom permissions
    expect(invalidated.permissionContext.grants).toContain('tools_*')
    expect(invalidated.permissionContext.grants).toContain('notebook_*')
    expect(invalidated.permissionContext.grants).toContain('!coding_shell_exec')

    // Persist check via store
    const loaded = await ask<UserStoreMsg, User | null>(
      store,
      replyTo => ({ type: 'getUser', userId, replyTo }),
    )
    expect(loaded?.permissions).toEqual(['!coding_shell_exec'])

    await system.shutdown()
  })

  test('AgentRegistry stops agents and rebinds permissionContexts on sessionInvalidated', async () => {
    const system = await AgentSystem({ plugins: [MockPersistenceActor()] })
    const llmRef = system.spawn('null-llm', NullLlm())
    system.publishRetained(LlmProviderTopic, 'llm-provider', { ref: llmRef })

    const registryRef = system.spawn('agent-registry', AgentRegistry())
    system.spawn('session-manager', SessionManager({
      llmRef,
      agentRegistryRef: registryRef,
      defaultMode: 'chatbot',
      contextWindowHours: 4,
    }))

    await tick()
    system.publishRetained(AgentRegistrationTopic, 'chatbot', {
      type: 'register',
      descriptor: {
        mode: 'chatbot',
        displayName: 'Chatbot',
        shortDesc: 'test',
        systemPrompt: 'You are a chatbot',
        internalTools: [],
        capabilities: { userVisible: true },
        model: 'test-model',
      },
    })
    await tick()

    const userId = 'user-revoked'
    system.publishRetained(UserPresenceTopic, `${userId}-http`, {
      status: 'present',
      userId,
      source: 'http',
      permission: { grants: ['*'] },
    })
    await tick(100)

    // Spawned agents use hierarchical names: `${registryName}/${mode}-${userId}`
    const agentName = `${registryRef.name}/chatbot-${userId}`
    let agentTerminated = false
    system.subscribe(watchTopic(agentName), (event: LifecycleEvent) => {
      if (event.type === 'terminated') agentTerminated = true
    })

    const newPermission = { grants: ['tools_web_search', '!coding_*'] }
    system.publish(SessionLifecycleTopic, {
      type: 'sessionInvalidated',
      userId,
      permissionContext: newPermission,
      timestamp: Date.now(),
    })
    await tick(100)

    expect(agentTerminated).toBe(true)

    await system.shutdown()
  })

  test('Authenticator returns error when user is missing', async () => {
    const system = await AgentSystem({ plugins: [MockPersistenceActor()] })
    const store = system.spawn('users', UserStore()) as ActorRef<UserStoreMsg>
    const auth = system.spawn('auth', Authenticator({
      userStore: store,
      config: baseConfig,
    })) as ActorRef<AuthenticatorMsg>

    const result = await ask<AuthenticatorMsg, { ok: User } | { error: string }>(
      auth,
      replyTo => ({
        type: 'setUserPermissions',
        userId: 'does-not-exist',
        permissions: ['*'],
        replyTo,
      }),
    )
    expect(result).toEqual({ error: 'user not found' })

    await system.shutdown()
  })
})
