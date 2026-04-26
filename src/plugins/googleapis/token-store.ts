import type { ActorDef, PersistenceAdapter } from '../../system/types.ts'
import { onMessage } from '../../system/match.ts'
import type { GoogleToken, TokenStoreMsg } from './types.ts'

// ─── State ───

export type TokenStoreState = {
  tokens: Record<string, GoogleToken>  // userId → token
}

export const initialTokenStoreState = (): TokenStoreState => ({ tokens: {} })

// ─── JSON persistence ───

const jsonPersistence = (filePath: string): PersistenceAdapter<TokenStoreState> => ({
  load: async () => {
    const file = Bun.file(filePath)
    if (!(await file.exists())) return undefined
    try {
      return await file.json() as TokenStoreState
    } catch {
      return undefined
    }
  },
  save: async (state) => {
    await Bun.write(filePath, JSON.stringify(state, null, 2))
  },
})

// ─── Actor definition ───

export const createTokenStoreActor = (filePath: string): ActorDef<TokenStoreMsg, TokenStoreState> => ({
  persistence: jsonPersistence(filePath),

  handler: onMessage<TokenStoreMsg, TokenStoreState>({
    getToken: (state, { userId, replyTo }) => {
      replyTo.send(state.tokens[userId] ?? null)
      return { state }
    },

    setToken: (state, { userId, token }) => ({
      state: { tokens: { ...state.tokens, [userId]: token } },
    }),

    deleteToken: (state, { userId }) => {
      const { [userId]: _removed, ...rest } = state.tokens
      return { state: { tokens: rest } }
    },
  }),
})
