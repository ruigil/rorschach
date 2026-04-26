import type { ActorDef } from '../../system/types.ts'
import { onMessage } from '../../system/match.ts'
import type { OAuthStateMsg } from './types.ts'

const STATE_TTL_MS = 10 * 60 * 1000  // 10 min

// ─── State ───

type OAuthStateActorState = {
  mapping: Record<string, string>  // state token → userId
}

export const initialOAuthStateActorState = (): OAuthStateActorState => ({ mapping: {} })

// ─── Actor definition ───

export const createOAuthStateActor = (): ActorDef<OAuthStateMsg, OAuthStateActorState> => ({
  handler: onMessage<OAuthStateMsg, OAuthStateActorState>({
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
