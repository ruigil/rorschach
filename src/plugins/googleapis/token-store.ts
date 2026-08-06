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
    getToken: (state, msg, ctx) => {
      const userId = ctx.request.userId
      msg.replyTo.send(state.tokens[userId] ?? null)
      return { state }
    },

    setToken: (state, msg, ctx) => {
      const userId = ctx.request.userId
      return {
        state: { tokens: { ...state.tokens, [userId]: msg.token } },
      }
    },

    deleteToken: (state, msg, ctx) => {
      const userId = ctx.request.userId
      const { [userId]: _removed, ...rest } = state.tokens
      return { state: { tokens: rest } }
    },
  }),
})
