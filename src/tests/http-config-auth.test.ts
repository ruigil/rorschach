import { describe, expect, test } from 'bun:test'
import { AgentSystem } from '../system/index.ts'
import type { ActorDef } from '../system/index.ts'
import { ask } from '../system/index.ts'
import { authorizeConfigAccess, canAccessAdminSurface } from '../plugins/interfaces/http.ts'
import { Authenticator, rolesForIdentity, type AuthConfig } from '../plugins/auth/authenticator.ts'
import { AuthenticatorRouter } from '../plugins/auth/authenticator-router.ts'
import { buildAuthRoutes } from '../plugins/auth/routes.ts'
import type { ActorRef } from '../system/index.ts'
import type { Identity, IdentityProviderMsg } from '../types/identity.ts'
import { ANONYMOUS_IDENTITY } from '../plugins/interfaces/types.ts'
import type { AuthenticatorMsg, AuthSession, User, UserStoreMsg } from '../plugins/auth/types.ts'
import { MockPersistenceActor } from './mock-persistence.ts'
import type { HttpRequestMsg, HttpResponseMsg } from '../types/routes.ts'

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
    if (msg.type === 'resolvePhone') msg.replyTo.send(Object.values(sessions).find(identity => identity.fullName === msg.phone) ?? null)
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
    if (msg.type === 'updateUser') {
      const user = users[msg.userId]
      if (user) {
        user.fullName = msg.fullName
        user.avatar = msg.avatar
        user.timezone = msg.timezone
        msg.replyTo.send({ ok: user })
      } else {
        msg.replyTo.send({ error: 'user not found' })
      }
    }
    return { state }
  },
})

const startIdentityProvider = async (
  identityProvider: ActorDef<IdentityProviderMsg, null>,
): Promise<{ ref: ActorRef<IdentityProviderMsg>; shutdown: () => Promise<void> }> => {
  const system = await AgentSystem({ plugins: [MockPersistenceActor()] })
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
    const identity: Identity = { userId: 'u1', fullName: 'user', roles: [] }
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
    const identity: Identity = { userId: 'u1', fullName: 'admin-user', roles: ['admin'] }
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
    const identity: Identity = { userId: 'u1', fullName: 'admin-user', roles: ['admin'] }
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
    const identity: Identity = { userId: 'u1', fullName: 'admin-user', roles: ['admin'] }
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
    const identity: Identity = { userId: 'u1', fullName: 'admin-user', roles: ['admin'] }
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
    const identity: Identity = { userId: 'u1', fullName: 'admin-user', roles: ['admin'] }
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
      admin: { userId: 'u-admin', fullName: 'admin', roles: ['admin'] },
      user:  { userId: 'u-user',  fullName: 'user',  roles: [] },
    }))

    expect(canAccessAdminSurface(ref, ['admin'])).toBe(true)
    expect(canAccessAdminSurface(ref, [])).toBe(false)

    await shutdown()
  })

  test('allows admin HTTP reads for admins and rejects non-admins', async () => {
    const observeUrl = 'http://127.0.0.1:3000/config/schema'
    const adminIdentity: Identity = { userId: 'u-admin', fullName: 'admin', roles: ['admin'] }
    const userIdentity: Identity = { userId: 'u-user', fullName: 'user', roles: [] }
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
      fullName: 'alice',
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
      fullName: 'mallory',
      phone: '+15551111111',
      roles: [],
    })).toEqual([])
  })

  test('rehydrates admin roles when validating an existing session token', async () => {
    const system = await AgentSystem({ plugins: [MockPersistenceActor()] })
    const user: User = {
      id: 'u-admin',
      fullName: 'alice',
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
            fullName: user.fullName,
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
    const system = await AgentSystem({ plugins: [MockPersistenceActor()] })
    const user: User = {
      id: 'u-admin',
      fullName: 'alice',
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
            fullName: user.fullName,
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

  test('getUserProfile and updateUserProfile handlers', async () => {
    const system = await AgentSystem({ plugins: [MockPersistenceActor()] })
    const user: User = {
      id: 'u-user',
      fullName: 'John Doe',
      createdAt: Date.now(),
      roles: [],
      deviceKeys: [],
    }
    const userStore = system.spawn('users', fakeUserStore({ [user.id]: user }))
    const auth = system.spawn('auth', Authenticator({ userStore: userStore as ActorRef<UserStoreMsg>, config: baseConfig })) as ActorRef<AuthenticatorMsg>

    const profile = await ask<AuthenticatorMsg, User | null>(
      auth,
      replyTo => ({ type: 'getUserProfile', userId: 'u-user', replyTo }),
    )
    expect(profile).toBeDefined()
    expect(profile?.fullName).toBe('John Doe')

    const updateRes = await ask<AuthenticatorMsg, { ok: User } | { error: string }>(
      auth,
      replyTo => ({ type: 'updateUserProfile', userId: 'u-user', fullName: 'Jane Doe', avatar: 'data:image/png;base64,...', replyTo }),
    )
    expect(updateRes).toBeDefined()
    expect('ok' in updateRes ? updateRes.ok.fullName : '').toBe('Jane Doe')
    expect('ok' in updateRes ? updateRes.ok.avatar : '').toBe('data:image/png;base64,...')

    await system.shutdown()
  })

  test('serves GET and POST /auth/profile routes', async () => {
    const system = await AgentSystem({ plugins: [MockPersistenceActor()] })
    const user: User = {
      id: 'u-user',
      fullName: 'John Doe',
      createdAt: Date.now(),
      roles: ['user'],
      deviceKeys: [],
    }
    const userStore = system.spawn('users', fakeUserStore({ [user.id]: user }))
    const auth = system.spawn('auth', Authenticator({ userStore: userStore as ActorRef<UserStoreMsg>, config: baseConfig })) as ActorRef<AuthenticatorMsg>
    const authRouter = system.spawn('auth-router', AuthenticatorRouter({ authenticator: auth, config: baseConfig }))
    
    const routes = buildAuthRoutes(authRouter)
    const getRoute = routes.find(r => r.id === 'auth.profile.get')
    const postRoute = routes.find(r => r.id === 'auth.profile.update')

    expect(getRoute).toBeDefined()
    expect(postRoute).toBeDefined()

    const identity: Identity = { userId: 'u-user', fullName: 'John Doe', roles: ['user'] }
    
    const getResMsg = await ask<HttpRequestMsg, HttpResponseMsg>(
      authRouter,
      replyTo => ({
        type: 'http.request',
        request: {
          method: 'GET',
          url: '/auth/profile',
          headers: {},
          body: null,
        },
        identity,
        replyTo,
      })
    )
    expect(getResMsg.response.status).toBe(200)
    const getData = JSON.parse(getResMsg.response.body as string)
    expect(getData.fullName).toBe('John Doe')
    expect(getData.timezone).toBe('')

    const postResMsg = await ask<HttpRequestMsg, HttpResponseMsg>(
      authRouter,
      replyTo => ({
        type: 'http.request',
        request: {
          method: 'POST',
          url: '/auth/profile',
          headers: {},
          body: JSON.stringify({ fullName: 'Jane Doe', avatar: 'avatar-data', timezone: 'America/New_York' }),
        },
        identity,
        replyTo,
      })
    )
    expect(postResMsg.response.status).toBe(200)
    const postData = JSON.parse(postResMsg.response.body as string)
    expect(postData.ok).toBe(true)
    expect(postData.user.fullName).toBe('Jane Doe')
    expect(postData.user.avatar).toBe('avatar-data')
    expect(postData.user.timezone).toBe('America/New_York')

    await system.shutdown()
  })

  test('serves auth static files via prefix dynamic route', async () => {
    const system = await AgentSystem({ plugins: [MockPersistenceActor()] })
    const user: User = {
      id: 'u-user',
      fullName: 'John Doe',
      createdAt: Date.now(),
      roles: ['user'],
      deviceKeys: [],
    }
    const userStore = system.spawn('users', fakeUserStore({ [user.id]: user }))
    const auth = system.spawn('auth', Authenticator({ userStore: userStore as ActorRef<UserStoreMsg>, config: baseConfig })) as ActorRef<AuthenticatorMsg>
    const authRouter = system.spawn('auth-router', AuthenticatorRouter({ authenticator: auth, config: baseConfig }))
    
    const routes = buildAuthRoutes(authRouter)
    const staticRoute = routes.find(r => r.id === 'auth.static')

    expect(staticRoute).toBeDefined()
    expect(staticRoute?.method).toBe('GET')
    expect(staticRoute?.path).toBe('/auth/')
    expect(staticRoute?.match).toBe('prefix')
    expect(staticRoute?.target).toBe(authRouter)

    // Test serving login.html on root /auth/
    const resRootMsg = await ask<HttpRequestMsg, HttpResponseMsg>(
      authRouter,
      replyTo => ({
        type: 'http.request',
        request: {
          method: 'GET',
          url: '/auth/',
          headers: {},
          body: null,
        },
        identity: null,
        replyTo,
      })
    )
    expect(resRootMsg.response.status).toBe(200)
    expect(resRootMsg.response.headers['Content-Type']).toContain('text/html')
    expect(resRootMsg.response.body as string).toContain('Sign in')

    // Test serving auth.js
    const resJsMsg = await ask<HttpRequestMsg, HttpResponseMsg>(
      authRouter,
      replyTo => ({
        type: 'http.request',
        request: {
          method: 'GET',
          url: '/auth/auth.js',
          headers: {},
          body: null,
        },
        identity: null,
        replyTo,
      })
    )
    expect(resJsMsg.response.status).toBe(200)
    expect(resJsMsg.response.headers['Content-Type']).toContain('application/javascript')
    expect(resJsMsg.response.body as string).toContain('openWebSocket')

    // Test directory traversal prevention
    const resTraversalMsg = await ask<HttpRequestMsg, HttpResponseMsg>(
      authRouter,
      replyTo => ({
        type: 'http.request',
        request: {
          method: 'GET',
          url: '/auth/../routes.ts',
          headers: {},
          body: null,
        },
        identity: null,
        replyTo,
      })
    )
    expect(resTraversalMsg.response.status).toBe(404)

    // Test nonexistent file 404
    const res404Msg = await ask<HttpRequestMsg, HttpResponseMsg>(
      authRouter,
      replyTo => ({
        type: 'http.request',
        request: {
          method: 'GET',
          url: '/auth/nonexistent.txt',
          headers: {},
          body: null,
        },
        identity: null,
        replyTo,
      })
    )
    expect(res404Msg.response.status).toBe(404)

    await system.shutdown()
  })
})

