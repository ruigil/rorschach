import { emit } from '../../system/index.ts'
import type { ActorDef, ActorRef } from '../../system/index.ts'
import { ask } from '../../system/index.ts'
import { onLifecycle, onMessage } from '../../system/index.ts'
import type {
  AuthenticatorMsg, AuthSession, AuthChallenge, DeviceKey, UserStoreMsg, User,
  RegistrationOptions, AuthenticationOptions,
} from './types.ts'
import { AuthLoginTopic, AuthLogoutTopic } from './types.ts'
import { computePermissionContext, rolesForIdentity } from './permissions.ts'
import { SessionLifecycleTopic } from '../../types/session.ts'
import {
  verifyRegistration, verifyAuthentication, generateToken, bytesToBase64url,
} from './webauthn.ts'

// ─── Config ───

// Re-exported from the co-located config module so internal modules and tests
// that imported the type here keep working untouched.
import type { AuthConfig } from './auth.config.ts'
export type { AuthConfig }
export { config as authConfig } from './auth.config.ts'

// Re-exported from permissions for backwards compatibility
export { rolesForIdentity }

// ─── State ───

export type AuthenticatorState = {
  challenges: Record<string, AuthChallenge>
  sessions:   Record<string, AuthSession>                        // token → session
  tickets:    Record<string, { token: string; expiresAt: number }>  // ticket → token
}

const initialAuthenticatorState = (): AuthenticatorState => ({
  challenges: {},
  sessions:   {},
  tickets:    {},
})

// ─── Actor factory ───

export const Authenticator = (opts: {
  userStore: ActorRef<UserStoreMsg>,
  config:    AuthConfig
}): ActorDef<AuthenticatorMsg, AuthenticatorState> => {
  const { userStore, config } = opts

  const rehydrateSession = async (session: AuthSession): Promise<AuthSession | null> => {
    const user = await ask<UserStoreMsg, User | null>(
      userStore,
      (r) => ({ type: 'getUser' as const, userId: session.userId, replyTo: r }),
      { timeoutMs: 3_000 },
    )
    if (!user) return null
    return {
      ...session,
      fullName: user.fullName,
      roles: rolesForIdentity(config, user),
      permission: computePermissionContext(config, user),
    }
  }

  return {
    initialState: initialAuthenticatorState,
    lifecycle: onLifecycle({
      start: (state, context) => {
        context.timers.startPeriodicTimer('gc', { type: '_gc' }, 60_000)
        return { state }
      },
    }),

    handler: onMessage<AuthenticatorMsg, AuthenticatorState>({

      // ─── Registration ───

      beginRegistration: (state, { phone, replyTo }) => {
        const challengeId    = crypto.randomUUID()
        const challengeValue = bytesToBase64url(crypto.getRandomValues(new Uint8Array(32)))
        const challenge: AuthChallenge = {
          id:        challengeId,
          value:     challengeValue,
          type:      'registration',
          fullName:  phone,
          expiresAt: Date.now() + config.challengeTtlMs,
        }
        const options = {
          challenge:              challengeValue,
          rp:                     { id: config.rpId, name: config.rpName },
          user:                   { id: challengeId, name: phone, displayName: phone },
          pubKeyCredParams:       [{ type: 'public-key' as const, alg: -7 }],
          timeout:                60_000,
          attestation:            'none' as const,
          authenticatorSelection: { residentKey: 'required' as const, userVerification: 'required' as const },
        }
        replyTo.send({ challengeId, options })
        return { state: { ...state, challenges: { ...state.challenges, [challengeId]: challenge } } }
      },

      finishRegistration: (state, { challengeId, credential, replyTo }, context) => {
        const challenge = state.challenges[challengeId]
        if (!challenge || challenge.type !== 'registration' || challenge.expiresAt < Date.now()) {
          replyTo.send({ error: 'invalid or expired challenge' })
          return { state }
        }
        if (credential.type !== 'registration') {
          replyTo.send({ error: 'expected registration credential' })
          return { state }
        }
        const phone = challenge.fullName!  // phone is stored as fullName initially

        const performRegistration = async () => {
          const { credentialId, publicKey, counter } = await verifyRegistration(
            challenge.value,
            credential as Extract<typeof credential, { type: 'registration' }>,
            config,
          )
          const roles = rolesForIdentity(config, { fullName: phone, phone })
          const createResult = await ask<UserStoreMsg, { ok: User } | { error: string }>(
            userStore,
            (r) => ({ type: 'createUser' as const, fullName: phone, phone, roles, replyTo: r }),
            { timeoutMs: 5_000 },
          )
          if ('error' in createResult) throw new Error(createResult.error)
          const deviceKey: DeviceKey = {
            id:           credentialId,
            publicKey,
            counter,
            deviceName:   'passkey',
            registeredAt: Date.now(),
          }
          const addResult = await ask<UserStoreMsg, { ok: true } | { error: string }>(
            userStore,
            (r) => ({ type: 'addDeviceKey' as const, userId: createResult.ok.id, key: deviceKey, replyTo: r }),
            { timeoutMs: 5_000 },
          )
          if ('error' in addResult) throw new Error(addResult.error)
          return {
            userId: createResult.ok.id,
            fullName: phone,
            roles: rolesForIdentity(config, createResult.ok),
            permissions: createResult.ok.permissions,
          }
        }

        context.pipeToSelf(
          performRegistration(),
          ({ userId, fullName: uname, roles, permissions }): AuthenticatorMsg => ({ type: '_regDone', userId, fullName: uname, roles, permissions, challengeId, replyTo }),
          (err): AuthenticatorMsg => ({ type: '_resultError', error: String(err), replyTo }),
        )

        return { state }
      },

      _regDone: (state, { userId, fullName, roles, permissions, challengeId, replyTo }) => {
        const token: string = generateToken()
        const session: AuthSession = {
          token,
          userId,
          fullName,
          roles,
          expiresAt: Date.now() + config.sessionTtlMs,
          permission: computePermissionContext(config, { fullName, roles, permissions }),
        }
        // Store fulfilledToken on challenge so desktop can poll for it
        const challenge = state.challenges[challengeId]
        const challenges = challenge
          ? { ...state.challenges, [challengeId]: { ...challenge, fulfilledToken: token } }
          : state.challenges
        replyTo.send({ token })
        return {
          state: { ...state, sessions: { ...state.sessions, [token]: session }, challenges },
          events: [emit(AuthLoginTopic, { userId, fullName, roles })],
        }
      },

      // ─── Authentication ───

      beginAuthentication: (state, { replyTo }) => {
        const challengeId    = crypto.randomUUID()
        const challengeValue = bytesToBase64url(crypto.getRandomValues(new Uint8Array(32)))
        const challenge: AuthChallenge = {
          id:        challengeId,
          value:     challengeValue,
          type:      'authentication',
          expiresAt: Date.now() + config.challengeTtlMs,
        }
        const options = {
          challenge:        challengeValue,
          rpId:             config.rpId,
          timeout:          60_000,
          allowCredentials: [] as Array<{ type: 'public-key'; id: string }>,
          userVerification: 'required' as const,
        }
        const qrPayload = bytesToBase64url(
          new TextEncoder().encode(JSON.stringify(options)),
        )
        replyTo.send({ challengeId, options, qrPayload })
        return { state: { ...state, challenges: { ...state.challenges, [challengeId]: challenge } } }
      },

      finishAuthentication: (state, { challengeId, credential, replyTo }, context) => {
        const challenge = state.challenges[challengeId]
        if (!challenge || challenge.type !== 'authentication' || challenge.expiresAt < Date.now()) {
          replyTo.send({ error: 'invalid or expired challenge' })
          return { state }
        }
        if (credential.type !== 'authentication') {
          replyTo.send({ error: 'expected authentication credential' })
          return { state }
        }
        const credentialId = credential.id

        const processAuthentication = async () => {
          const user = await ask<UserStoreMsg, User | null>(
            userStore,
            (r) => ({ type: 'getUserByCredential' as const, credentialId, replyTo: r }),
            { timeoutMs: 5_000 },
          )
          if (!user) throw new Error('credential not found')
          const deviceKey = user.deviceKeys.find(k => k.id === credentialId)
          if (!deviceKey) throw new Error('device key not found')
          const { newCounter } = await verifyAuthentication(
            challenge.value,
            credential as Extract<typeof credential, { type: 'authentication' }>,
            deviceKey,
            config,
          )
          return {
            userId: user.id,
            fullName: user.fullName,
            roles: rolesForIdentity(config, user),
            permissions: user.permissions,
            newCounter,
          }
        }

        context.pipeToSelf(
          processAuthentication(),
          ({ userId, fullName, roles, permissions, newCounter }): AuthenticatorMsg =>
            ({ type: '_authDone', userId, fullName, roles, permissions, challengeId, credentialId, newCounter, replyTo }),
          (err): AuthenticatorMsg => ({ type: '_resultError', error: String(err), replyTo }),
        )

        return { state }
      },

      _authDone: (state, { userId, fullName, roles, permissions, challengeId, credentialId, newCounter, replyTo }) => {
        const token: string = generateToken()
        const session: AuthSession = {
          token,
          userId,
          fullName,
          roles,
          expiresAt: Date.now() + config.sessionTtlMs,
          permission: computePermissionContext(config, { fullName, roles, permissions }),
        }
        // Update signCount in user store (fire and forget)
        userStore.send({ type: 'updateKeyCounter', credentialId, counter: newCounter })
        // Set fulfilledToken on challenge for QR poll
        const challenge = state.challenges[challengeId]
        const challenges = challenge
          ? { ...state.challenges, [challengeId]: { ...challenge, fulfilledToken: token } }
          : state.challenges
        replyTo.send({ token })
        return {
          state: { ...state, sessions: { ...state.sessions, [token]: session }, challenges },
          events: [emit(AuthLoginTopic, { userId, fullName, roles })],
        }
      },

      // ─── Generic pipeToSelf reply forwarding ───

      _resultOk: (state, { replyTo, value }) => {
        replyTo.send(value)
        return { state }
      },

      _resultError: (state, { replyTo, error }) => {
        replyTo.send({ error })
        return { state }
      },

      // ─── QR helpers ───

      getRegOptions: (state, { challengeId, replyTo }) => {
        const challenge = state.challenges[challengeId]
        if (!challenge || challenge.type !== 'registration' || challenge.expiresAt < Date.now()) {
          replyTo.send(null)
          return { state }
        }
        const options: RegistrationOptions = {
          challenge:              challenge.value,
          rp:                     { id: config.rpId, name: config.rpName },
          user:                   { id: challengeId, name: challenge.fullName!, displayName: challenge.fullName! },
          pubKeyCredParams:       [{ type: 'public-key' as const, alg: -7 }],
          timeout:                60_000,
          attestation:            'none' as const,
          authenticatorSelection: { residentKey: 'required' as const, userVerification: 'required' as const },
        }
        replyTo.send(options)
        return { state }
      },

      getAuthOptions: (state, { challengeId, replyTo }) => {
        const challenge = state.challenges[challengeId]
        if (!challenge || challenge.type !== 'authentication' || challenge.expiresAt < Date.now()) {
          replyTo.send(null)
          return { state }
        }
        const options: AuthenticationOptions = {
          challenge:        challenge.value,
          rpId:             config.rpId,
          timeout:          60_000,
          allowCredentials: [],
          userVerification: 'required' as const,
        }
        replyTo.send(options)
        return { state }
      },

      pollChallenge: (state, { challengeId, replyTo }) => {
        const challenge = state.challenges[challengeId]
        if (!challenge || challenge.expiresAt < Date.now()) {
          replyTo.send({ error: 'challenge not found or expired' })
          return { state }
        }
        if (!challenge.fulfilledToken) {
          replyTo.send({ pending: true })
          return { state }
        }
        const token = challenge.fulfilledToken
        // Consume: remove challenge so poll can only succeed once
        const { [challengeId]: _, ...challenges } = state.challenges
        replyTo.send({ token })
        return { state: { ...state, challenges } }
      },

      pollRegistration: (state, { challengeId, replyTo }) => {
        const challenge = state.challenges[challengeId]
        if (!challenge || challenge.expiresAt < Date.now()) {
          replyTo.send({ error: 'challenge not found or expired' })
          return { state }
        }
        if (!challenge.fulfilledToken) {
          replyTo.send({ pending: true })
          return { state }
        }
        const token = challenge.fulfilledToken
        const { [challengeId]: _, ...challenges } = state.challenges
        replyTo.send({ token })
        return { state: { ...state, challenges } }
      },

      // ─── Session / token ───

      validateToken: (state, { token, replyTo }, ctx) => {
        const session = state.sessions[token]
        if (!session || session.expiresAt < Date.now()) {
          if (session) {
            const { [token]: _, ...sessions } = state.sessions
            replyTo.send(null)
            return { state: { ...state, sessions }, events: [] }
          }
          replyTo.send(null)
          return { state }
        }
        ctx.pipeToSelf(
          rehydrateSession(session),
          (nextSession): AuthenticatorMsg => ({ type: '_resultOk', value: nextSession, replyTo }),
          // Fall back to the cached session if UserStore rehydrate fails
          (): AuthenticatorMsg => ({ type: '_resultOk', value: session, replyTo }),
        )
        return { state }
      },

      revokeToken: (state, { token }) => {
        const session = state.sessions[token]
        if (!session) return { state }
        const { [token]: _, ...sessions } = state.sessions
        return {
          state: { ...state, sessions },
          events: [emit(AuthLogoutTopic, { userId: session.userId })],
        }
      },

      issueTicket: (state, { token, replyTo }) => {
        const session = state.sessions[token]
        if (!session || session.expiresAt < Date.now()) {
          replyTo.send({ error: 'invalid session' })
          return { state }
        }
        const ticket = generateToken()
        replyTo.send({ ticket })
        return {
          state: {
            ...state,
            tickets: { ...state.tickets, [ticket]: { token, expiresAt: Date.now() + config.ticketTtlMs } },
          },
        }
      },

      validateTicket: (state, { ticket, replyTo }, ctx) => {
        const entry = state.tickets[ticket]
        if (!entry || entry.expiresAt < Date.now()) {
          replyTo.send(null)
          return { state }
        }
        // Consume ticket (single-use)
        const { [ticket]: _, ...tickets } = state.tickets
        const session = state.sessions[entry.token]
        if (!session || session.expiresAt < Date.now()) {
          replyTo.send(null)
          return { state: { ...state, tickets } }
        }
        ctx.pipeToSelf(
          rehydrateSession(session),
          (nextSession): AuthenticatorMsg => ({ type: '_resultOk', value: nextSession, replyTo }),
          // Fall back to the cached session if UserStore rehydrate fails
          (): AuthenticatorMsg => ({ type: '_resultOk', value: session, replyTo }),
        )
        return { state: { ...state, tickets } }
      },

      getUserProfile: (state, { replyTo }, ctx) => {
        const userId = ctx.request.userId
        ctx.pipeToSelf(
          ctx.ask<UserStoreMsg, User | null>(
            userStore,
            (r) => ({ type: 'getUser' as const, userId, replyTo: r }),
            { timeoutMs: 3_000 },
          ),
          (user): AuthenticatorMsg => ({ type: '_resultOk', value: user, replyTo }),
          (): AuthenticatorMsg => ({ type: '_resultOk', value: null, replyTo }),
        )
        return { state }
      },

      updateUserProfile: (state, { fullName, avatar, timezone, replyTo }, ctx) => {
        const userId = ctx.request.userId
        ctx.pipeToSelf(
          ctx.ask<UserStoreMsg, { ok: User } | { error: string }>(
            userStore,
            (r) => ({ type: 'updateUser' as const, userId, fullName, avatar, timezone, replyTo: r }),
            { timeoutMs: 3_000 },
          ),
          (result): AuthenticatorMsg =>
            'error' in result
              ? { type: '_resultError', error: result.error, replyTo }
              : { type: '_resultOk', value: result, replyTo },
          (err): AuthenticatorMsg => ({ type: '_resultError', error: String(err), replyTo }),
        )
        return { state }
      },

      // ─── Permissions (persist via UserStore, then invalidate sessions) ───

      setUserPermissions: (state, { userId, permissions, replyTo }, ctx) => {
        ctx.pipeToSelf(
          ask<UserStoreMsg, { ok: User } | { error: string }>(
            userStore,
            (r) => ({ type: 'setUserPermissions' as const, userId, permissions, replyTo: r }),
            { timeoutMs: 3_000 },
          ),
          (res): AuthenticatorMsg =>
            'error' in res
              ? { type: '_resultError', error: res.error, replyTo }
              : { type: '_setUserPermissionsDone', user: res.ok, replyTo },
          (err): AuthenticatorMsg => ({ type: '_resultError', error: String(err), replyTo }),
        )
        return { state }
      },

      _setUserPermissionsDone: (state, { user, replyTo }) => {
        const roles = rolesForIdentity(config, user)
        const permissionContext = computePermissionContext(config, {
          fullName: user.fullName,
          roles,
          permissions: user.permissions,
        })
        replyTo.send({ ok: user })
        return {
          state,
          events: [emit(SessionLifecycleTopic, {
            type: 'sessionInvalidated',
            userId: user.id,
            permissionContext,
            timestamp: Date.now(),
          })],
        }
      },

      // ─── GC ───

      _gc: (state) => {
        const now = Date.now()
        const challenges = Object.fromEntries(
          Object.entries(state.challenges).filter(([, c]) => c.expiresAt > now),
        )
        const sessions = Object.fromEntries(
          Object.entries(state.sessions).filter(([, s]) => s.expiresAt > now),
        )
        const tickets = Object.fromEntries(
          Object.entries(state.tickets).filter(([, t]) => t.expiresAt > now),
        )
        return { state: { challenges, sessions, tickets } }
      },
    }),
  }
}
