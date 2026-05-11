import type { ActorDef, ActorRef } from '../../system/types.ts'
import { onLifecycle, onMessage } from '../../system/match.ts'
import { ClientConnectTopic, ClientDisconnectTopic, InboundMessageTopic, CronTriggerTopic, OutboundMessageTopic } from '../../types/events.ts'
import type { LlmProviderMsg } from '../../types/llm.ts'
import { HistoryStore } from './history-store.ts'
import type { HistoryStoreMsg } from './history-store.ts'
import {
  AgentRegistrationTopic,
  SwitchAgentTopic,
  type AgentDescriptor,
  type AgentFactoryOpts,
} from './types.ts'

// ─── Configuration ─────────────────────────────────────────────────────────

/** The mode used for first-connect activation and for cron-triggered turns. */
const DEFAULT_MODE = 'chatbot'

// ─── Message protocol ──────────────────────────────────────────────────────

type SessionManagerMsg =
  | { type: '_connected';        clientId: string; userId: string; roles: string[] }
  | { type: '_disconnected';     clientId: string }
  | { type: '_message';          clientId: string; text: string; images?: string[]; audio?: string; pdfs?: string[]; traceId: string; parentSpanId: string; isCron?: boolean }
  | { type: '_cronTrigger';      userId: string; text: string; traceId: string; parentSpanId: string }
  | { type: '_agentRegistered';  descriptor: AgentDescriptor }
  | { type: '_agentUnregistered'; mode: string }
  | { type: '_switchAgent';      clientId: string; mode: string; source: 'user' | 'llm' | 'programmatic'; reason?: string }

// ─── State ─────────────────────────────────────────────────────────────────
//
// One actor tree per userId:
//   history-store-${userId}                  — owns shared conversation state
//   ${mode}-${userId}                        — per-mode agent actors (lazily spawned)
//
// `descriptors` mirrors the agent-registry catalog (this actor subscribes
// independently — no ask-pattern on the hot path).
// `agentRefs[userId][mode]` are spawned lazily on first activation of that
// mode for that user.
// `activeMode[userId]` decides which agent receives the next inbound message.

type SessionManagerState = {
  descriptors:    Record<string, AgentDescriptor>                          // mode → descriptor
  historyStores:  Record<string, ActorRef<HistoryStoreMsg>>                // userId → history store
  agentRefs:      Record<string, Record<string, ActorRef<any>>>            // userId → mode → agent
  activeMode:     Record<string, string>                                   // userId → active mode
  clientIndex:    Record<string, string>                                   // clientId → userId
  activeClients:  Record<string, number>                                   // userId → connection count
}

const initialSessionManagerState = (): SessionManagerState => ({
  descriptors:   {},
  historyStores: {},
  agentRefs:     {},
  activeMode:    {},
  clientIndex:   {},
  activeClients: {},
})

// ─── Options ───────────────────────────────────────────────────────────────

export type SessionManagerOptions = {
  llmRef:              ActorRef<LlmProviderMsg>
  historyWindowHours?: number
}

// ─── Helpers ───────────────────────────────────────────────────────────────

const ensureHistoryStore = (
  state: SessionManagerState,
  userId: string,
  ctx: any,
  historyWindowHours: number | undefined,
): { state: SessionManagerState; ref: ActorRef<HistoryStoreMsg> } => {
  const existing = state.historyStores[userId]
  if (existing) return { state, ref: existing }
  const ref = ctx.spawn(
    `history-store-${userId}`,
    HistoryStore({ userId, historyWindowHours }),
  ) as ActorRef<HistoryStoreMsg>
  return {
    state: { ...state, historyStores: { ...state.historyStores, [userId]: ref } },
    ref,
  }
}

const ensureAgent = (
  state: SessionManagerState,
  userId: string,
  mode: string,
  clientId: string,
  llmRef: ActorRef<LlmProviderMsg>,
  ctx: any,
): { state: SessionManagerState; ref: ActorRef<any> | null } => {
  const userAgents = state.agentRefs[userId] ?? {}
  const existing = userAgents[mode]
  if (existing) return { state, ref: existing }

  const descriptor = state.descriptors[mode]
  if (!descriptor) {
    ctx.log.warn('session-manager: unknown agent mode', { mode })
    return { state, ref: null }
  }

  const historyStoreRef = state.historyStores[userId]
  if (!historyStoreRef) {
    ctx.log.error('session-manager: history-store missing for user', { userId, mode })
    return { state, ref: null }
  }

  const opts: AgentFactoryOpts = { userId, clientId, llmRef, historyStoreRef }
  const ref = ctx.spawn(
    `${mode}-${userId}`,
    descriptor.factory(opts),
  ) as ActorRef<any>

  return {
    state: {
      ...state,
      agentRefs: {
        ...state.agentRefs,
        [userId]: { ...userAgents, [mode]: ref },
      },
    },
    ref,
  }
}

const userIdOfClient = (state: SessionManagerState, clientId: string): string | undefined =>
  state.clientIndex[clientId]

// ─── Actor ─────────────────────────────────────────────────────────────────

export const SessionManager = (
  options: SessionManagerOptions,
): ActorDef<SessionManagerMsg, SessionManagerState> => {
  const { llmRef, historyWindowHours } = options

  return {
    initialState: initialSessionManagerState,
    lifecycle: onLifecycle({
      start: (state, ctx) => {
        ctx.subscribe(ClientConnectTopic,    e => ({ type: '_connected'    as const, clientId: e.clientId, userId: e.userId, roles: e.roles }))
        ctx.subscribe(ClientDisconnectTopic, e => ({ type: '_disconnected' as const, clientId: e.clientId }))
        ctx.subscribe(InboundMessageTopic,   e => ({ type: '_message'      as const, clientId: e.clientId, text: e.text, images: e.images, audio: e.audio, pdfs: e.pdfs, traceId: e.traceId, parentSpanId: e.parentSpanId, isCron: e.isCron }))
        ctx.subscribe(CronTriggerTopic,      e => ({ type: '_cronTrigger'  as const, userId: e.userId, text: e.text, traceId: e.traceId, parentSpanId: e.parentSpanId }))
        ctx.subscribe(AgentRegistrationTopic, e =>
          e.type === 'register'
            ? { type: '_agentRegistered'   as const, descriptor: e.descriptor }
            : { type: '_agentUnregistered' as const, mode:       e.mode },
        )
        ctx.subscribe(SwitchAgentTopic,      e => ({ type: '_switchAgent'  as const, clientId: e.clientId, mode: e.mode, source: e.source, reason: e.reason }))
        return { state }
      },

      terminated: (state, event) => {
        // If a per-user history-store or agent dies, clean up our refs.
        for (const [userId, ref] of Object.entries(state.historyStores)) {
          if (ref.name === event.ref.name) {
            const { [userId]: _, ...historyStores } = state.historyStores
            const { [userId]: __, ...agentRefs } = state.agentRefs
            const { [userId]: ___, ...activeMode } = state.activeMode
            const { [userId]: ____, ...activeClients } = state.activeClients
            const clientIndex = Object.fromEntries(Object.entries(state.clientIndex).filter(([, uid]) => uid !== userId))
            return { state: { ...state, historyStores, agentRefs, activeMode, activeClients, clientIndex } }
          }
        }
        for (const [userId, modeMap] of Object.entries(state.agentRefs)) {
          for (const [mode, ref] of Object.entries(modeMap)) {
            if (ref.name === event.ref.name) {
              const { [mode]: _, ...rest } = modeMap
              const newAgentRefs = { ...state.agentRefs, [userId]: rest }
              // If this was the active mode, fall back to default.
              const newActiveMode = state.activeMode[userId] === mode
                ? { ...state.activeMode, [userId]: DEFAULT_MODE }
                : state.activeMode
              return { state: { ...state, agentRefs: newAgentRefs, activeMode: newActiveMode } }
            }
          }
        }
        return { state }
      },
    }),

    handler: onMessage<SessionManagerMsg, SessionManagerState>({

      _agentRegistered: (state, msg) => ({
        state: { ...state, descriptors: { ...state.descriptors, [msg.descriptor.mode]: msg.descriptor } },
      }),

      _agentUnregistered: (state, msg) => {
        const { [msg.mode]: _, ...descriptors } = state.descriptors
        return { state: { ...state, descriptors } }
      },

      _connected: (state, msg, ctx) => {
        const { clientId, userId } = msg

        // Reuse existing per-user resources if this user already has a session.
        if (state.activeClients[userId]) {
          return {
            state: {
              ...state,
              clientIndex:   { ...state.clientIndex,   [clientId]: userId },
              activeClients: { ...state.activeClients, [userId]: state.activeClients[userId]! + 1 },
            },
          }
        }

        // First connect for this userId — spawn history store + default agent.
        const afterStore = ensureHistoryStore(state, userId, ctx, historyWindowHours)
        const afterAgent = ensureAgent(afterStore.state, userId, DEFAULT_MODE, clientId, llmRef, ctx)

        return {
          state: {
            ...afterAgent.state,
            clientIndex:   { ...afterAgent.state.clientIndex,   [clientId]: userId },
            activeClients: { ...afterAgent.state.activeClients, [userId]: 1 },
            activeMode:    { ...afterAgent.state.activeMode,    [userId]: DEFAULT_MODE },
          },
        }
      },

      _disconnected: (state, msg, ctx) => {
        const { clientId } = msg
        const userId = userIdOfClient(state, clientId)
        if (!userId) return { state }

        const count = (state.activeClients[userId] ?? 1) - 1
        const { [clientId]: _, ...clientIndex } = state.clientIndex
        if (count > 0) {
          return { state: { ...state, clientIndex, activeClients: { ...state.activeClients, [userId]: count } } }
        }

        // Last client gone — tear down everything for this user.
        const userAgents = state.agentRefs[userId] ?? {}
        for (const ref of Object.values(userAgents)) ctx.stop(ref)
        const storeRef = state.historyStores[userId]
        if (storeRef) ctx.stop(storeRef)

        const { [userId]: __, ...historyStores } = state.historyStores
        const { [userId]: ___, ...agentRefs } = state.agentRefs
        const { [userId]: ____, ...activeMode } = state.activeMode
        const { [userId]: _____, ...activeClients } = state.activeClients
        return { state: { ...state, clientIndex, historyStores, agentRefs, activeMode, activeClients } }
      },

      _message: (state, msg) => {
        const { clientId, text, images, audio, pdfs, traceId, parentSpanId, isCron } = msg
        const userId = userIdOfClient(state, clientId)
        if (!userId) return { state }
        const mode = state.activeMode[userId] ?? DEFAULT_MODE
        const agent = state.agentRefs[userId]?.[mode]
        agent?.send({ type: 'userMessage', clientId, text, images, audio, pdfs, traceId, parentSpanId, isCron, isInjected: isCron })
        return { state }
      },

      _cronTrigger: (state, msg, ctx) => {
        const { userId, text, traceId, parentSpanId } = msg
        // Cron always targets the default mode (chatbot) — avoid surprising a
        // user who left a non-default mode active.
        const agent = state.agentRefs[userId]?.[DEFAULT_MODE]
        if (!agent) {
          ctx.log.warn('cron job fired but user not connected', { userId })
          return { state }
        }
        const clientId = Object.entries(state.clientIndex).find(([, uid]) => uid === userId)?.[0]
        if (!clientId) {
          ctx.log.warn('cron job fired but no clientId found for user', { userId })
          return { state }
        }
        agent.send({ type: 'userMessage', clientId, text, traceId, parentSpanId, isCron: true, isInjected: true })
        return { state }
      },

      _switchAgent: (state, msg, ctx) => {
        const { clientId, mode, reason } = msg
        const userId = userIdOfClient(state, clientId)
        if (!userId) {
          ctx.log.warn('switchAgent: unknown clientId', { clientId, mode })
          return { state }
        }

        const descriptor = state.descriptors[mode]
        if (!descriptor) {
          ctx.log.warn('switchAgent: unknown mode', { clientId, mode })
          ctx.publish(OutboundMessageTopic, {
            clientId,
            text: JSON.stringify({ type: 'error', text: `Unknown agent mode: ${mode}` }),
          })
          return { state }
        }

        // Ensure target agent exists.
        const afterAgent = ensureAgent(state, userId, mode, clientId, llmRef, ctx)
        if (!afterAgent.ref) return { state: afterAgent.state }

        const next: SessionManagerState = {
          ...afterAgent.state,
          activeMode: { ...afterAgent.state.activeMode, [userId]: mode },
        }

        ctx.publish(OutboundMessageTopic, {
          clientId,
          text: JSON.stringify({ type: 'modeChanged', mode, displayName: descriptor.displayName }),
        })
        ctx.log.info('session-manager: agent switched', { userId, mode, reason })

        return { state: next }
      },
    }),

    supervision: { type: 'restart', maxRetries: 3, withinMs: 30_000 },
  }
}
