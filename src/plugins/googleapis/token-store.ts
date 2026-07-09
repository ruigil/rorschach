import { onMessage, persistencePluginAdapter, type ActorDef } from '../../system/index.ts'
import type { GoogleToken, TokenStoreMsg } from './types.ts'

// ─── State ───

export type TokenStoreState = {
  tokens: Record<string, GoogleToken>  // userId → token
}

const initialTokenStoreState = (): TokenStoreState => ({ tokens: {} })

// ─── Actor definition ───

export const TokenStore = (): ActorDef<TokenStoreMsg, TokenStoreState> => ({
  initialState: initialTokenStoreState,
  persistence: persistencePluginAdapter<TokenStoreState>('googleapis/tokens'),

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
