import { describe, expect, test } from 'bun:test'
import { AgentSystem, ask, watchTopic, staticSource} from '../system/index.ts'
import type { ActorDef, ActorRef, LifecycleEvent } from '../system/index.ts'
import { Authenticator } from '../plugins/auth/authenticator.ts'
import type { AuthConfig } from '../plugins/auth/auth.config.ts'
import { UserStore } from '../plugins/auth/user-store.ts'
import type { AuthenticatorMsg, User, UserStoreMsg } from '../plugins/auth/types.ts'
import { SessionLifecycleTopic, type SessionLifecycleEvent } from '../types/session.ts'
import { LlmProviderTopic, type LlmProviderMsg } from '../types/llm.ts'
import { UserPresenceTopic } from '../types/events.ts'

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
  handler: (state, msg, ctx) => {
    if (msg && typeof msg === 'object' && msg.type === 'stream') {
      ctx.send(msg.replyTo, { type: 'llmChunk', requestId: msg.requestId, text: 'agent-ready' })
      ctx.send(msg.replyTo, { type: 'llmDone', requestId: msg.requestId, usage: { promptTokens: 1, completionTokens: 1 } })
    }
    return { state }
  },
})

describe('Permissions Revocation', () => {
  test('UserStore setUserPermissions replaces permissions array', async () => {
    const system = await AgentSystem({ source: staticSource({ plugins: [MockPersistenceActor()] }) })
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
    const system = await AgentSystem({ source: staticSource({ plugins: [MockPersistenceActor()] }) })
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



  test('Authenticator returns error when user is missing', async () => {
    const system = await AgentSystem({ source: staticSource({ plugins: [MockPersistenceActor()] }) })
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
