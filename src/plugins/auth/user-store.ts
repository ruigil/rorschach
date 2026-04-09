import type { ActorDef, PersistenceAdapter } from '../../system/types.ts'
import { onMessage } from '../../system/match.ts'
import type { User, UserId, DeviceKey, UserStoreMsg } from './types.ts'

// ─── State ───

export type UserStoreState = {
  users:           Record<UserId, User>
  usernameIndex:   Record<string, UserId>
  credentialIndex: Record<string, UserId>
  phoneIndex:      Record<string, UserId>
}

export const initialUserStoreState = (): UserStoreState => ({
  users:           {},
  usernameIndex:   {},
  credentialIndex: {},
  phoneIndex:      {},
})

// ─── JSON persistence ───
// DeviceKey.publicKey is already a base64url string so JSON round-trips cleanly.

const jsonPersistence = (filePath: string): PersistenceAdapter<UserStoreState> => ({
  load: async () => {
    const file = Bun.file(filePath)
    if (!(await file.exists())) return undefined
    try {
      return await file.json() as UserStoreState
    } catch {
      return undefined
    }
  },
  save: async (state) => {
    await Bun.write(filePath, JSON.stringify(state, null, 2))
  },
})

// ─── Actor definition ───

export const createUserStoreActor = (filePath: string): ActorDef<UserStoreMsg, UserStoreState> => ({
  persistence: jsonPersistence(filePath),

  handler: onMessage<UserStoreMsg, UserStoreState>({
    createUser: (state, { username, phone, replyTo }) => {
      if (state.usernameIndex[username]) {
        replyTo.send({ error: 'username already taken' })
        return { state }
      }
      if (phone && state.phoneIndex[phone]) {
        replyTo.send({ error: 'phone already registered' })
        return { state }
      }
      const user: User = {
        id:         crypto.randomUUID(),
        username,
        phone,
        createdAt:  Date.now(),
        roles:      [],
        deviceKeys: [],
      }
      replyTo.send({ ok: user })
      return {
        state: {
          users:           { ...state.users,         [user.id]: user },
          usernameIndex:   { ...state.usernameIndex, [username]: user.id },
          credentialIndex: state.credentialIndex,
          phoneIndex:      phone ? { ...state.phoneIndex, [phone]: user.id } : state.phoneIndex,
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
