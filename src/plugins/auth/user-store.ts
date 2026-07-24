import { onMessage, persistencePluginAdapter, type ActorDef } from '../../system/index.ts'
import type { User, UserId, DeviceKey, UserStoreMsg } from './types.ts'

// ─── State ───

export type UserStoreState = {
  users:           Record<UserId, User>
  credentialIndex: Record<string, UserId>
  phoneIndex:      Record<string, UserId>
}

const initialUserStoreState = (): UserStoreState => ({
  users:           {},
  credentialIndex: {},
  phoneIndex:      {},
})

// ─── Actor definition ───

export const UserStore = (): ActorDef<UserStoreMsg, UserStoreState> => ({
  initialState: initialUserStoreState,
  persistence: persistencePluginAdapter<UserStoreState>('auth/users'),

  handler: onMessage<UserStoreMsg, UserStoreState>({
    createUser: (state, { fullName, phone, roles, replyTo }) => {
      if (phone && state.phoneIndex[phone]) {
        replyTo.send({ error: 'phone already registered' })
        return { state }
      }
      const user: User = {
        id:         crypto.randomUUID(),
        fullName,
        phone,
        createdAt:  Date.now(),
        roles:      roles ?? [],
        deviceKeys: [],
      }
      replyTo.send({ ok: user })
      return {
        state: {
          ...state,
          users:           { ...state.users,         [user.id]: user },
          phoneIndex:      phone ? { ...state.phoneIndex, [phone]: user.id } : state.phoneIndex,
        },
      }
    },

    updateUser: (state, { userId, fullName, avatar, timezone, replyTo }) => {
      const user = state.users[userId]
      if (!user) {
        replyTo.send({ error: 'user not found' })
        return { state }
      }
      const updatedUser: User = {
        ...user,
        fullName,
        avatar,
        timezone: timezone !== undefined ? timezone : user.timezone,
      }
      replyTo.send({ ok: updatedUser })
      return {
        state: {
          ...state,
          users: { ...state.users, [userId]: updatedUser },
        },
      }
    },

    getUser: (state, { userId, replyTo }) => {
      replyTo.send(state.users[userId] ?? null)
      return { state }
    },

    getUserByCredential: (state, { credentialId, replyTo }) => {
      const userId = state.credentialIndex[credentialId]
      replyTo.send(userId ? (state.users[userId] ?? null) : null)
      return { state }
    },

    getUserByPhone: (state, { phone, replyTo }) => {
      const userId = state.phoneIndex[phone]
      replyTo.send(userId ? (state.users[userId] ?? null) : null)
      return { state }
    },

    addDeviceKey: (state, { userId, key, replyTo }) => {
      const user = state.users[userId]
      if (!user) {
        replyTo.send({ error: 'user not found' })
        return { state }
      }
      const updatedUser: User = { ...user, deviceKeys: [...user.deviceKeys, key] }
      replyTo.send({ ok: true })
      return {
        state: {
          ...state,
          users:           { ...state.users,           [userId]: updatedUser },
          credentialIndex: { ...state.credentialIndex, [key.id]: userId },
        },
      }
    },

    updateKeyCounter: (state, { credentialId, counter }) => {
      const userId = state.credentialIndex[credentialId]
      const user   = userId ? state.users[userId] : undefined
      if (!user) return { state }
      const updatedUser: User = {
        ...user,
        deviceKeys: user.deviceKeys.map(k => k.id === credentialId ? { ...k, counter } : k),
      }
      return { state: { ...state, users: { ...state.users, [userId!]: updatedUser } } }
    },

    listUsers: (state, { replyTo }) => {
      replyTo.send(Object.values(state.users))
      return { state }
    },
  }),
})
