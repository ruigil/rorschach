import type { ActorDef } from '../../system/index.ts'
import { onMessage } from '../../system/index.ts'
import type { OAuthStateMsg } from './types.ts'

const STATE_TTL_MS = 10 * 60 * 1000  // 10 min

// ─── State ───

type OAuthStateState = {
  mapping: Record<string, string>  // state token → userId
}

const initialOAuthStateState = (): OAuthStateState => ({ mapping: {} })

// ─── Actor definition ───

export const OAuthState = (): ActorDef<OAuthStateMsg, OAuthStateState> => ({
  initialState: initialOAuthStateState,
  handler: onMessage<OAuthStateMsg, OAuthStateState>({
    createState: (state, msg, ctx) => {
      const token = crypto.randomUUID()
      ctx.timers.startSingleTimer(`expire-${token}`, { type: '_expire', state: token }, STATE_TTL_MS)
      msg.replyTo.send(token)
      return { state: { mapping: { ...state.mapping, [token]: msg.userId } } }
    },

    resolveState: (state, msg) => {
      const userId = state.mapping[msg.state] ?? null
      msg.replyTo.send(userId)
      if (!userId) return { state }
      const { [msg.state]: _removed, ...rest } = state.mapping
      return { state: { mapping: rest } }
    },

    _expire: (state, msg) => {
      const { [msg.state]: _removed, ...rest } = state.mapping
      return { state: { mapping: rest } }
    },
  }),
})
