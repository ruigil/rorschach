import { describe, expect, test } from 'bun:test'
import { AgentSystem } from '../system/index.ts'
import type { ActorDef } from '../system/index.ts'
import { ask } from '../system/index.ts'
import { authorizeConfigAccess, canAccessAdminSurface } from '../plugins/interfaces/http.ts'
import { Authenticator, rolesForIdentity, type AuthConfig } from '../plugins/auth/authenticator.ts'
import type { ActorRef } from '../system/index.ts'
import type { Identity, IdentityProviderMsg } from '../types/identity.ts'
import { ANONYMOUS_IDENTITY } from '../plugins/interfaces/types.ts'
import type { AuthenticatorMsg, AuthSession, User, UserStoreMsg } from '../plugins/auth/types.ts'

const tick = (ms = 50) => Bun.sleep(ms)

const configUrl = 'http://127.0.0.1:3000/config/tools'

const configRequest = (init?: RequestInit): Request =>
  new Request(configUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    body: JSON.stringify({ webSearch: { count: 3 } }),
    ...init,
  })

const fakeIdentityProvider = (sessions: Record<string, Identity>): ActorDef<IdentityProviderMsg, null> => ({
  initialState: null,
  handler: (state, msg) => {
    if (msg.type === 'resolveCookie') msg.replyTo.send(sessions[msg.cookie] ?? null)
    if (msg.type === 'resolveTicket') msg.replyTo.send(msg.ticket ? (sessions[msg.ticket] ?? null) : null)
    if (msg.type === 'resolvePhone') msg.replyTo.send(Object.values(sessions).find(identity => identity.username === msg.phone) ?? null)
    return { state }
  },
})

const fakeUserStore = (users: Record<string, User>): ActorDef<UserStoreMsg, null> => ({
  initialState: null,
  handler: (state, msg) => {
    if (msg.type === 'getUser') msg.replyTo.send(users[msg.userId] ?? null)
    if (msg.type === 'getUserByCredential') msg.replyTo.send(Object.values(users).find(user => user.deviceKeys.some(key => key.id === msg.credentialId)) ?? null)
    if (msg.type === 'getUserByPhone') msg.replyTo.send(Object.values(users).find(user => user.phone === msg.phone) ?? null)
    if (msg.type === 'listUsers') msg.replyTo.send(Object.values(users))
    if (msg.type === 'createUser') msg.replyTo.send({ error: 'not implemented' })
    return { state }
  },
})

const startIdentityProvider = async (
  identityProvider: ActorDef<IdentityProviderMsg, null>,
): Promise<{ ref: ActorRef<IdentityProviderMsg>; shutdown: () => Promise<void> }> => {
  const system = await AgentSystem()
  const ref = system.spawn('identity', identityProvider)
  await tick()
  return { ref, shutdown: () => system.shutdown() }
}

describe('HTTP config update authorization', () => {
  test('allows anonymous config access when no auth provider is loaded', async () => {
    const denied = await authorizeConfigAccess(null, configRequest(), new URL(configUrl), ANONYMOUS_IDENTITY, { requireSameOrigin: true })
    expect(denied).toBeNull()
  })

  test('rejects config writes without a valid session when auth is loaded', async () => {
    const { ref, shutdown } = await startIdentityProvider(fakeIdentityProvider({}))

    const denied = await authorizeConfigAccess(ref, configRequest(), new URL(configUrl), null, { requireSameOrigin: true })

    expect(denied?.status).toBe(401)

    await shutdown()
  })

  test('rejects authenticated config writes without a privileged role', async () => {
    const identity: Identity = { userId: 'u1', username: 'user', roles: [] }
    const { ref, shutdown } = await startIdentityProvider(fakeIdentityProvider({
      plain: identity,
    }))

    const denied = await authorizeConfigAccess(ref, configRequest({
      headers: { Cookie: 'session=plain' },
    }), new URL(configUrl), identity, { requireSameOrigin: true })

    expect(denied?.status).toBe(403)

    await shutdown()
  })

  test('allows authenticated config writes with admin role', async () => {
    const identity: Identity = { userId: 'u1', username: 'admin-user', roles: ['admin'] }
    const { ref, shutdown } = await startIdentityProvider(fakeIdentityProvider({
      privileged: identity,
    }))

    const denied = await authorizeConfigAccess(ref, configRequest({
      headers: { Cookie: 'session=privileged' },
    }), new URL(configUrl), identity, { requireSameOrigin: true })

    expect(denied).toBeNull()

    await shutdown()
  })

  test('rejects cross-origin config writes before publishing updates', async () => {
    const identity: Identity = { userId: 'u1', username: 'admin-user', roles: ['admin'] }
    const { ref, shutdown } = await startIdentityProvider(fakeIdentityProvider({
      privileged: identity,
    }))

    const denied = await authorizeConfigAccess(ref, configRequest({
      headers: { Cookie: 'session=privileged', Origin: 'http://evil.example' },
    }), new URL(configUrl), identity, { requireSameOrigin: true })

    expect(denied?.status).toBe(403)

    await shutdown()
  })

  test('allows proxied same-origin config writes with forwarded headers', async () => {
    const identity: Identity = { userId: 'u1', username: 'admin-user', roles: ['admin'] }
    const { ref, shutdown } = await startIdentityProvider(fakeIdentityProvider({
      privileged: identity,
    }))

    const denied = await authorizeConfigAccess(ref, configRequest({
      headers: {
        Cookie: 'session=privileged',
        Origin: 'https://rorschach.example',
        'X-Forwarded-Host': 'rorschach.example',
        'X-Forwarded-Proto': 'https',
      },
    }), new URL(configUrl), identity, { requireSameOrigin: true })

    expect(denied).toBeNull()

    await shutdown()
  })

  test('allows same-host config writes when TLS terminates before Bun', async () => {
    const identity: Identity = { userId: 'u1', username: 'admin-user', roles: ['admin'] }
    const { ref, shutdown } = await startIdentityProvider(fakeIdentityProvider({
      privileged: identity,
    }))

    const denied = await authorizeConfigAccess(ref, configRequest({
      headers: {
        Cookie: 'session=privileged',
        Host: 'rorschach.example',
        Origin: 'https://rorschach.example',
      },
    }), new URL('http://rorschach.example/config/tools'), identity, { requireSameOrigin: true })

    expect(denied).toBeNull()

    await shutdown()
  })

  test('allows proxied same-origin config writes with Forwarded header', async () => {
    const identity: Identity = { userId: 'u1', username: 'admin-user', roles: ['admin'] }
    const { ref, shutdown } = await startIdentityProvider(fakeIdentityProvider({
      privileged: identity,
    }))

    const denied = await authorizeConfigAccess(ref, configRequest({
      headers: {
        Cookie: 'session=privileged',
        Origin: 'https://rorschach.example',
        Forwarded: 'for=192.0.2.1;proto=https;host=rorschach.example',
      },
    }), new URL(configUrl), identity, { requireSameOrigin: true })

    expect(denied).toBeNull()

    await shutdown()
  })
})

describe('admin surface access', () => {
  test('allows admin surfaces in anonymous mode', () => {
    expect(canAccessAdminSurface(null, [])).toBe(true)
  })

  test('allows admin surfaces for authenticated admins only', async () => {
    const { ref, shutdown } = await startIdentityProvider(fakeIdentityProvider({
      admin: { userId: 'u-admin', username: 'admin', roles: ['admin'] },
      user:  { userId: 'u-user',  username: 'user',  roles: [] },
    }))

    expect(canAccessAdminSurface(ref, ['admin'])).toBe(true)
    expect(canAccessAdminSurface(ref, [])).toBe(false)

    await shutdown()
  })

  test('allows admin HTTP reads for admins and rejects non-admins', async () => {
    const observeUrl = 'http://127.0.0.1:3000/kgraph'
    const adminIdentity: Identity = { userId: 'u-admin', username: 'admin', roles: ['admin'] }
    const userIdentity: Identity = { userId: 'u-user', username: 'user', roles: [] }
    const { ref, shutdown } = await startIdentityProvider(fakeIdentityProvider({
      admin: adminIdentity,
      user:  userIdentity,
    }))

    const adminDenied = await authorizeConfigAccess(ref, new Request(observeUrl, {
      headers: { Cookie: 'session=admin' },
    }), new URL(observeUrl), adminIdentity)
    const userDenied = await authorizeConfigAccess(ref, new Request(observeUrl, {
      headers: { Cookie: 'session=user' },
    }), new URL(observeUrl), userIdentity)

    expect(adminDenied).toBeNull()
    expect(userDenied?.status).toBe(403)

    await shutdown()
  })
})

describe('auth admin allowlist', () => {
  const baseConfig: AuthConfig = {
    rpId: 'localhost',
    rpName: 'Rorschach',
    origin: 'http://localhost:3000',
    baseUrl: 'http://localhost:3000',
    sessionTtlMs: 1_000,
    challengeTtlMs: 1_000,
    ticketTtlMs: 1_000,
  }

  test('grants admin to matching configured users', () => {
    expect(rolesForIdentity({
      ...baseConfig,
      admins: { usernames: 'alice\nbob', phones: '+15550000000', userIds: ['u-admin'] },
    }, {
      userId: 'u1',
      username: 'alice',
      phone: '+15551111111',
      roles: [],
    })).toContain('admin')
  })

  test('keeps non-matching users unprivileged', () => {
    expect(rolesForIdentity({
      ...baseConfig,
      admins: { usernames: 'alice', phones: '+15550000000', userIds: ['u-admin'] },
    }, {
      userId: 'u1',
      username: 'mallory',
      phone: '+15551111111',
      roles: [],
    })).toEqual([])
  })

  test('rehydrates admin roles when validating an existing session token', async () => {
    const system = await AgentSystem()
    const user: User = {
      id: 'u-admin',
      username: 'alice',
      createdAt: Date.now(),
      roles: ['admin'],
      deviceKeys: [],
    }
    const userStore = system.spawn('users', fakeUserStore({ [user.id]: user }))
    const auth = system.spawn('auth', Authenticator({ userStore: userStore as ActorRef<UserStoreMsg>, config: baseConfig }), {
      state: {
        challenges: {},
        tickets: {},
        sessions: {
          stale: {
            token: 'stale',
            userId: user.id,
            username: user.username,
            roles: [],
            expiresAt: Date.now() + 60_000,
          },
        },
      },
    }) as ActorRef<AuthenticatorMsg>

    const session = await ask<AuthenticatorMsg, AuthSession | null>(
      auth,
      replyTo => ({ type: 'validateToken' as const, token: 'stale', replyTo }),
    )

    expect(session?.roles).toContain('admin')

    await system.shutdown()
  })

  test('rehydrates admin roles when validating a websocket ticket', async () => {
    const system = await AgentSystem()
    const user: User = {
      id: 'u-admin',
      username: 'alice',
      createdAt: Date.now(),
      roles: ['admin'],
      deviceKeys: [],
    }
    const userStore = system.spawn('users', fakeUserStore({ [user.id]: user }))
    const auth = system.spawn('auth', Authenticator({ userStore: userStore as ActorRef<UserStoreMsg>, config: baseConfig }), {
      state: {
        challenges: {},
        tickets: { ticket: { token: 'stale', expiresAt: Date.now() + 60_000 } },
        sessions: {
          stale: {
            token: 'stale',
            userId: user.id,
            username: user.username,
            roles: [],
            expiresAt: Date.now() + 60_000,
          },
        },
      },
    }) as ActorRef<AuthenticatorMsg>

    const session = await ask<AuthenticatorMsg, AuthSession | null>(
      auth,
      replyTo => ({ type: 'validateTicket' as const, ticket: 'ticket', replyTo }),
    )

    expect(session?.roles).toContain('admin')

    await system.shutdown()
  })
})
