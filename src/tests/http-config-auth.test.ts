import { describe, expect, test } from 'bun:test'
import { AgentSystem, staticSource} from '../system/index.ts'
import type { ActorDef } from '../system/index.ts'
import { ask } from '../system/index.ts'
import { authorizeRouteAccess, canAccessAdminSurface } from '../plugins/interfaces/http.ts'
import { startServer, type ResolvedRoute } from '../plugins/interfaces/http/server.ts'
import { Authenticator } from '../plugins/auth/authenticator.ts'
import { rolesForIdentity } from '../plugins/auth/permissions.ts'
import type { AuthConfig } from '../plugins/auth/auth.config.ts'
import { AuthenticatorRouter } from '../plugins/auth/authenticator-router.ts'
import { buildAuthRoutes } from '../plugins/auth/auth.routes.ts'
import type { ActorRef } from '../system/index.ts'
import type { Identity, IdentityProviderMsg } from '../types/identity.ts'
import { ANONYMOUS_IDENTITY } from '../plugins/interfaces/types.ts'
import type { AuthenticatorMsg, AuthSession, User, UserStoreMsg } from '../plugins/auth/types.ts'
import { MockPersistenceActor } from './mock-persistence.ts'
import type { HttpRequestMsg, HttpResponseMsg } from '../types/routes.ts'

const tick = (ms = 50) => Bun.sleep(ms)

/** Policy declared on config routes (buildConfigRoutes). */
const configPolicy = { auth: 'admin' as const, sameOrigin: 'non-GET' as const }

const configUrl = 'http://127.0.0.1:3000/config/tools'

const configRequest = (init?: RequestInit): Request =>
  new Request(configUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    body: JSON.stringify({ webSearch: { count: 3 } }),
    ...init,
  })

const authorizeConfig = (
  provider: ActorRef<IdentityProviderMsg> | null,
  req: Request,
  url: URL,
  identity: Identity | null,
) => authorizeRouteAccess(provider, req, url, identity, configPolicy)

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
    if (msg.type === 'setUserPermissions') {
      const user = users[msg.userId]
      if (user) {
        user.permissions = [...msg.permissions]
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
  const system = await AgentSystem({ source: staticSource({ plugins: [MockPersistenceActor()] }) })
  const ref = system.spawn('identity', identityProvider)
  await tick()
  return { ref, shutdown: () => system.shutdown() }
}

describe('HTTP config update authorization', () => {
  test('allows anonymous config access when no auth provider is loaded', () => {
    const denied = authorizeConfig(null, configRequest(), new URL(configUrl), ANONYMOUS_IDENTITY)
    expect(denied).toBeNull()
  })

  test('rejects config writes without a valid session when auth is loaded', async () => {
    const { ref, shutdown } = await startIdentityProvider(fakeIdentityProvider({}))

    const denied = authorizeConfig(ref, configRequest(), new URL(configUrl), null)

    expect(denied?.status).toBe(401)

    await shutdown()
  })

  test('rejects authenticated config writes without a privileged role', async () => {
    const identity: Identity = { userId: 'u1', fullName: 'user', roles: [] }
    const { ref, shutdown } = await startIdentityProvider(fakeIdentityProvider({
      plain: identity,
    }))

    const denied = authorizeConfig(ref, configRequest({
      headers: { Cookie: 'session=plain' },
    }), new URL(configUrl), identity)

    expect(denied?.status).toBe(403)

    await shutdown()
  })

  test('allows authenticated config writes with admin role', async () => {
    const identity: Identity = { userId: 'u1', fullName: 'admin-user', roles: ['admin'] }
    const { ref, shutdown } = await startIdentityProvider(fakeIdentityProvider({
      privileged: identity,
    }))

    const denied = authorizeConfig(ref, configRequest({
      headers: { Cookie: 'session=privileged' },
    }), new URL(configUrl), identity)

    expect(denied).toBeNull()

    await shutdown()
  })

  test('rejects cross-origin config writes before publishing updates', async () => {
    const identity: Identity = { userId: 'u1', fullName: 'admin-user', roles: ['admin'] }
    const { ref, shutdown } = await startIdentityProvider(fakeIdentityProvider({
      privileged: identity,
    }))

    const denied = authorizeConfig(ref, configRequest({
      headers: { Cookie: 'session=privileged', Origin: 'http://evil.example' },
    }), new URL(configUrl), identity)

    expect(denied?.status).toBe(403)

    await shutdown()
  })

  test('allows proxied same-origin config writes with forwarded headers', async () => {
    const identity: Identity = { userId: 'u1', fullName: 'admin-user', roles: ['admin'] }
    const { ref, shutdown } = await startIdentityProvider(fakeIdentityProvider({
      privileged: identity,
    }))

    const denied = authorizeConfig(ref, configRequest({
      headers: {
        Cookie: 'session=privileged',
        Origin: 'https://rorschach.example',
        'X-Forwarded-Host': 'rorschach.example',
        'X-Forwarded-Proto': 'https',
      },
    }), new URL(configUrl), identity)

    expect(denied).toBeNull()

    await shutdown()
  })

  test('allows same-host config writes when TLS terminates before Bun', async () => {
    const identity: Identity = { userId: 'u1', fullName: 'admin-user', roles: ['admin'] }
    const { ref, shutdown } = await startIdentityProvider(fakeIdentityProvider({
      privileged: identity,
    }))

    const denied = authorizeConfig(ref, configRequest({
      headers: {
        Cookie: 'session=privileged',
        Host: 'rorschach.example',
        Origin: 'https://rorschach.example',
      },
    }), new URL('http://rorschach.example/config/tools'), identity)

    expect(denied).toBeNull()

    await shutdown()
  })

  test('allows proxied same-origin config writes with Forwarded header', async () => {
    const identity: Identity = { userId: 'u1', fullName: 'admin-user', roles: ['admin'] }
    const { ref, shutdown } = await startIdentityProvider(fakeIdentityProvider({
      privileged: identity,
    }))

    const denied = authorizeConfig(ref, configRequest({
      headers: {
        Cookie: 'session=privileged',
        Origin: 'https://rorschach.example',
        Forwarded: 'for=192.0.2.1;proto=https;host=rorschach.example',
      },
    }), new URL(configUrl), identity)

    expect(denied).toBeNull()

    await shutdown()
  })
})

describe('HTTP server route authorization gate (C-1 regression)', () => {
  // A non-null identity provider ref simulates "auth plugin loaded" —
  // canAccessAdminSurface then requires the admin role.
  const loadedProviderRef = { name: 'fake-provider', isAlive: () => true, send: () => {} } as ActorRef<IdentityProviderMsg>

  // Admin route metadata as declared by buildConfigRoutes — no path hardcoding in the gateway.
  const adminRoute: ResolvedRoute = {
    target: { name: 'fake-target', isAlive: () => true, send: () => {} } as ActorRef<HttpRequestMsg>,
    auth: 'admin',
    sameOrigin: 'non-GET',
  }

  const startTestServer = (
    identity: Identity | null,
    resolveRoute: (method: string, pathname: string) => ResolvedRoute | undefined = (method, pathname) =>
      (pathname === '/config' || pathname.startsWith('/config/')) ? adminRoute : undefined,
  ) =>
    startServer({
      port: 0,
      PUBLIC_DIR: '/tmp/rorschach-test-public-does-not-exist',
      MEDIA_DIR: '',
      checkAdmin: () => false,
      resolveIdentity: async () => null,
      resolveCookieIdentity: async () => identity,
      authorizeRoute: (req, url, id, policy) => authorizeRouteAccess(loadedProviderRef, req, url, id, policy),
      resolveRegisteredRoute: resolveRoute,
      onConnect: () => {},
      onDisconnect: () => {},
      onMessage: () => {},
      uploadMedia: async () => ({ ok: false as const, error: 'n/a' }),
      fetchMedia: async () => null,
    })

  test('rejects unauthenticated GET on admin route with 401', async () => {
    const server = startTestServer(null)
    try {
      const res = await fetch(`http://localhost:${server.port}/config`)
      expect(res.status).toBe(401)
    } finally {
      server.stop(true)
    }
  })

  test('rejects authenticated non-admin GET on admin route with 403', async () => {
    const server = startTestServer({ userId: 'u1', fullName: 'user', roles: [] })
    try {
      const res = await fetch(`http://localhost:${server.port}/config`)
      expect(res.status).toBe(403)
    } finally {
      server.stop(true)
    }
  })

  test('lets authenticated admin past the gate and dispatches to target', async () => {
    // Target answers so we observe dispatch (not 404) after the auth gate.
    let dispatched = false
    const target = {
      name: 'config-target',
      isAlive: () => true,
      send: (msg: any) => {
        if (msg.type === 'http.request') {
          dispatched = true
          msg.replyTo.send({
            type: 'http.response',
            response: { status: 200, headers: { 'Content-Type': 'application/json' }, body: '{}' },
          })
        }
      },
    } as ActorRef<HttpRequestMsg>

    const server = startTestServer(
      { userId: 'u-admin', fullName: 'admin', roles: ['admin'] },
      (method, pathname) =>
        (pathname === '/config' || pathname.startsWith('/config/'))
          ? { target, auth: 'admin', sameOrigin: 'non-GET' }
          : undefined,
    )
    try {
      const res = await fetch(`http://localhost:${server.port}/config`)
      expect(res.status).toBe(200)
      expect(dispatched).toBe(true)

      dispatched = false
      const nested = await fetch(`http://localhost:${server.port}/config/values/tools`)
      expect(nested.status).toBe(200)
      expect(dispatched).toBe(true)
    } finally {
      server.stop(true)
    }
  })

  test('does not apply admin policy to unregistered lookalike paths', async () => {
    const server = startTestServer(null)
    try {
      const res = await fetch(`http://localhost:${server.port}/configurations`)
      expect(res.status).toBe(404)
    } finally {
      server.stop(true)
    }
  })

  test('rejects session-protected route without identity with 401', async () => {
    const sessionRoute: ResolvedRoute = {
      target: { name: 'session-target', isAlive: () => true, send: () => {} } as ActorRef<HttpRequestMsg>,
      auth: 'session',
    }
    const server = startTestServer(null, (method, pathname) =>
      pathname === '/artifact' ? sessionRoute : undefined,
    )
    try {
      const res = await fetch(`http://localhost:${server.port}/artifact`)
      expect(res.status).toBe(401)
    } finally {
      server.stop(true)
    }
  })

  test('allows public route without identity', async () => {
    let dispatched = false
    const publicRoute: ResolvedRoute = {
      target: {
        name: 'public-target',
        isAlive: () => true,
        send: (msg: any) => {
          if (msg.type === 'http.request') {
            dispatched = true
            msg.replyTo.send({
              type: 'http.response',
              response: { status: 200, headers: {}, body: 'ok' },
            })
          }
        },
      } as ActorRef<HttpRequestMsg>,
      auth: 'public',
    }
    const server = startTestServer(null, (method, pathname) =>
      pathname === '/auth/login/begin' ? publicRoute : undefined,
    )
    try {
      const res = await fetch(`http://localhost:${server.port}/auth/login/begin`, { method: 'POST' })
      expect(res.status).toBe(200)
      expect(dispatched).toBe(true)
    } finally {
      server.stop(true)
    }
  })
})

describe('route registration auth metadata', () => {
  test('config routes declare admin + non-GET sameOrigin', async () => {
    const { buildConfigRoutes } = await import('../plugins/config/config.routes.ts')
    const fakeTarget = { name: 'cfg', isAlive: () => true, send: () => {} } as ActorRef<HttpRequestMsg>
    const routes = buildConfigRoutes(fakeTarget)
    expect(routes.length).toBeGreaterThan(0)
    for (const route of routes) {
      if (route.target === null) continue
      expect(route.auth).toBe('admin')
      expect(route.sameOrigin).toBe('non-GET')
    }
  })

  test('session routes declare session auth', async () => {
    const { buildCodingRoutes } = await import('../plugins/coding/coding.routes.ts')
    const { buildWorkflowsRoutes } = await import('../plugins/workflows/workflows.routes.ts')
    const { buildGoogleOAuthRoutes } = await import('../plugins/googleapis/googleapis.routes.ts')
    const { buildAuthRoutes } = await import('../plugins/auth/auth.routes.ts')
    const fakeTarget = { name: 't', isAlive: () => true, send: () => {} } as ActorRef<HttpRequestMsg>

    expect(buildCodingRoutes(fakeTarget)[0]?.auth).toBe('session')
    expect(buildWorkflowsRoutes(fakeTarget)[0]?.auth).toBe('session')

    const google = buildGoogleOAuthRoutes(fakeTarget)
    expect(google.find(r => r.id === 'googleapis.auth.start' && r.target)?.auth).toBe('session')
    expect(google.find(r => r.id === 'googleapis.auth.callback' && r.target)?.auth).toBeUndefined()

    const auth = buildAuthRoutes(fakeTarget)
    expect(auth.find(r => r.id === 'auth.profile.get' && r.target)?.auth).toBe('session')
    expect(auth.find(r => r.id === 'auth.ticket' && r.target)?.auth).toBe('session')
    expect(auth.find(r => r.id === 'auth.logout' && r.target)?.auth).toBe('session')
    expect(auth.find(r => r.id === 'auth.login.begin' && r.target)?.auth).toBeUndefined()
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

    // GETs with sameOrigin: 'non-GET' skip the Origin check; only admin role applies.
    const adminDenied = authorizeRouteAccess(ref, new Request(observeUrl, {
      headers: { Cookie: 'session=admin' },
    }), new URL(observeUrl), adminIdentity, configPolicy)
    const userDenied = authorizeRouteAccess(ref, new Request(observeUrl, {
      headers: { Cookie: 'session=user' },
    }), new URL(observeUrl), userIdentity, configPolicy)

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
    const system = await AgentSystem({ source: staticSource({ plugins: [MockPersistenceActor()] }) })
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
    const system = await AgentSystem({ source: staticSource({ plugins: [MockPersistenceActor()] }) })
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
    const system = await AgentSystem({ source: staticSource({ plugins: [MockPersistenceActor()] }) })
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
      replyTo => ({ type: 'getUserProfile', replyTo }),
      undefined,
      { userId: 'u-user' }
    )
    expect(profile).toBeDefined()
    expect(profile?.fullName).toBe('John Doe')

    const updateRes = await ask<AuthenticatorMsg, { ok: User } | { error: string }>(
      auth,
      replyTo => ({ type: 'updateUserProfile', fullName: 'Jane Doe', avatar: 'data:image/png;base64,...', replyTo }),
      undefined,
      { userId: 'u-user' }
    )
    expect(updateRes).toBeDefined()
    expect('ok' in updateRes ? updateRes.ok.fullName : '').toBe('Jane Doe')
    expect('ok' in updateRes ? updateRes.ok.avatar : '').toBe('data:image/png;base64,...')

    await system.shutdown()
  })

  test('serves GET and POST /auth/profile routes', async () => {
    const system = await AgentSystem({ source: staticSource({ plugins: [MockPersistenceActor()] }) })
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
        replyTo,
      }),
      undefined,
      { userId: identity.userId, roles: identity.roles }
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
        replyTo,
      }),
      undefined,
      { userId: identity.userId, roles: identity.roles }
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
    const system = await AgentSystem({ source: staticSource({ plugins: [MockPersistenceActor()] }) })
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
        replyTo,
      })
    )
    expect(res404Msg.response.status).toBe(404)

    await system.shutdown()
  })
})

