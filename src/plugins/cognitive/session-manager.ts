import type { ActorDef, ActorRef } from '../../system/types.ts'
import { onLifecycle, onMessage } from '../../system/match.ts'
import {
  ClientPresenceTopic,
  InboundMessageTopic,
  CronTriggerTopic,
  OutboundMessageTopic,
  type MessageAttachment,
} from '../../types/events.ts'
import type { LlmProviderMsg } from '../../types/llm.ts'
import { HistoryStore, type HistoryStoreMsg} from './history-store.ts'
import {
  AgentRegistrationTopic,
  SessionLifecycleTopic,
  SwitchAgentTopic,
  type AgentDescriptor,
  type AgentFactoryOpts,
} from '../../types/agents.ts'

// ─── Message protocol ──────────────────────────────────────────────────────

type SessionManagerMsg =
  | { type: '_connected';        clientId: string; userId: string; roles: string[] }
  | { type: '_disconnected';     clientId: string }
  | { type: '_message';          clientId: string; text: string; attachments?: MessageAttachment[]; traceId: string; parentSpanId: string; isCron?: boolean }
  | { type: '_cronTrigger';      userId: string; text: string; traceId: string; parentSpanId: string }
  | { type: '_agentRegistered';  descriptor: AgentDescriptor }
  | { type: '_agentUnregistered'; mode: string }
  | { type: '_switchAgent';      clientId: string; mode: string; source: 'user' | 'llm' | 'programmatic'; reason?: string }

// ─── State ─────────────────────────────────────────────────────────────────
//
// One Session record per active userId. Agents are spawned lazily on first
// activation of a (userId, mode) pair. clientCount tracks how many client
// connections are currently associated with the userId — the session is torn
// down when it hits zero.

type Session = {
  historyStoreRef: ActorRef<HistoryStoreMsg>
  agentRefs:       Record<string, ActorRef<any>>   // mode → agent
  activeMode:      string
  clientCount:     number
}

type SessionManagerState = {
  descriptors: Record<string, AgentDescriptor>     // mode → descriptor (catalog mirror)
  sessions:    Record<string, Session>              // userId → Session
  clientIndex: Record<string, string>               // clientId → userId
}

const initialSessionManagerState = (): SessionManagerState => ({
  descriptors: {},
  sessions:    {},
  clientIndex: {},
})

// ─── Options ───────────────────────────────────────────────────────────────

export type SessionManagerOptions = {
  llmRef:              ActorRef<LlmProviderMsg>
  defaultMode:         string                   // resolved by the plugin; first-connect / cron / fallback target
  historyWindowHours?: number
  workPath?:           string
}

// ─── Helpers ───────────────────────────────────────────────────────────────

const updateSession = (state: SessionManagerState, userId: string, patch: Partial<Session> ): SessionManagerState => ({
  ...state,
  sessions: { ...state.sessions, [userId]: { ...state.sessions[userId]!, ...patch } },
})

const setSession = (state: SessionManagerState, userId: string, session: Session ): SessionManagerState => ({
  ...state,
  sessions: { ...state.sessions, [userId]: session },
})

const removeSession = (state: SessionManagerState, userId: string): SessionManagerState => {
  const { [userId]: _, ...sessions } = state.sessions
  const clientIndex = Object.fromEntries(
    Object.entries(state.clientIndex).filter(([, uid]) => uid !== userId),
  )
  return { ...state, sessions, clientIndex }
}

const ensureAgent = (
  state: SessionManagerState,
  userId: string,
  mode: string,
  clientId: string,
  llmRef: ActorRef<LlmProviderMsg>,
  ctx: any,
): { state: SessionManagerState; ref: ActorRef<any> | null } => {
  const session = state.sessions[userId]
  if (!session) {
    ctx.log.error('session-manager: no session for user', { userId, mode })
    return { state, ref: null }
  }

  const existing = session.agentRefs[mode]
  if (existing) return { state, ref: existing }

  const descriptor = state.descriptors[mode]
  if (!descriptor) {
    ctx.log.warn('session-manager: unknown agent mode', { mode })
    return { state, ref: null }
  }

  const opts: AgentFactoryOpts = {
    userId,
    clientId,
    llmRef,
    historyStoreRef: session.historyStoreRef,
  }
  const ref = ctx.spawn(`${mode}-${userId}`, descriptor.factory(opts)) as ActorRef<any>

  return {
    state: updateSession(state, userId, {
      agentRefs: { ...session.agentRefs, [mode]: ref },
    }),
    ref,
  }
}

const userIdOfClient = (state: SessionManagerState, clientId: string): string | undefined =>
  state.clientIndex[clientId]

const clientIdsForUser = (state: SessionManagerState, userId: string): string[] =>
  Object.entries(state.clientIndex)
    .filter(([, uid]) => uid === userId)
    .map(([clientId]) => clientId)

const firstClientIdForUser = (state: SessionManagerState, userId: string): string | undefined =>
  Object.entries(state.clientIndex).find(([, uid]) => uid === userId)?.[0]

const publishModeChanged = (
  state: SessionManagerState,
  clientIds: string[],
  mode: string,
  ctx: any,
) => {
  const descriptor = state.descriptors[mode]
  const displayName = descriptor?.displayName ?? mode
  for (const clientId of clientIds) {
    ctx.publish(OutboundMessageTopic, {
      clientId,
      text: JSON.stringify({ type: 'modeChanged', mode, displayName }),
    })
  }
}

// ─── Actor ─────────────────────────────────────────────────────────────────

export const SessionManager = (
  options: SessionManagerOptions,
): ActorDef<SessionManagerMsg, SessionManagerState> => {
  const { llmRef, defaultMode, historyWindowHours, workPath } = options

  return {
    initialState: initialSessionManagerState,
    lifecycle: onLifecycle({
      start: (state, ctx) => {
        ctx.subscribe(ClientPresenceTopic, e =>
          e.status === 'connected'
            ? { type: '_connected' as const, clientId: e.clientId, userId: e.userId, roles: e.roles }
            : { type: '_disconnected' as const, clientId: e.clientId },
        )
        ctx.subscribe(InboundMessageTopic,   e => ({ type: '_message'      as const, clientId: e.clientId, text: e.text, attachments: e.attachments, traceId: e.traceId, parentSpanId: e.parentSpanId, isCron: e.isCron }))
        ctx.subscribe(CronTriggerTopic,      e => ({ type: '_cronTrigger'  as const, userId: e.userId, text: e.text, traceId: e.traceId, parentSpanId: e.parentSpanId }))
        ctx.subscribe(AgentRegistrationTopic, e =>
          e.type === 'register'
            ? { type: '_agentRegistered'   as const, descriptor: e.descriptor }
            : { type: '_agentUnregistered' as const, mode:       e.mode },
        )
        ctx.subscribe(SwitchAgentTopic,      e => ({ type: '_switchAgent'  as const, clientId: e.clientId, mode: e.mode, source: e.source, reason: e.reason }))
        return { state }
      },

      terminated: (state, event, ctx) => {
        const deadName = event.ref.name
        // History-store death cascades into a full session drop.
        for (const [userId, session] of Object.entries(state.sessions)) {
          if (session.historyStoreRef.name === deadName) {
            ctx.publish(SessionLifecycleTopic, {
              type:      'sessionEnded',
              userId,
              reason:    'historyStoreCrash',
              timestamp: Date.now(),
            })
            return { state: removeSession(state, userId) }
          }
        }
        // Agent death: remove from its session, and fall back to defaultMode if it was active.
        for (const [userId, session] of Object.entries(state.sessions)) {
          for (const [mode, ref] of Object.entries(session.agentRefs)) {
            if (ref.name === deadName) {
              const { [mode]: _, ...remaining } = session.agentRefs
              const patch: Partial<Session> = { agentRefs: remaining }
              if (session.activeMode === mode) {
                patch.activeMode = defaultMode
                publishModeChanged(state, clientIdsForUser(state, userId), defaultMode, ctx)
                ctx.publish(SessionLifecycleTopic, {
                  type:         'modeActivated',
                  userId,
                  mode:         defaultMode,
                  previousMode: mode,
                  source:       'crashFallback',
                  timestamp:    Date.now(),
                })
              }
              return { state: updateSession(state, userId, patch) }
            }
          }
        }
        return { state }
      },
    }),

    handler: onMessage<SessionManagerMsg, SessionManagerState>({

      _agentRegistered: (state, msg, ctx) => {
        let next: SessionManagerState = {
          ...state,
          descriptors: { ...state.descriptors, [msg.descriptor.mode]: msg.descriptor },
        }

        for (const [userId, session] of Object.entries(next.sessions)) {
          if (session.activeMode !== msg.descriptor.mode || session.agentRefs[msg.descriptor.mode]) continue
          const clientId = firstClientIdForUser(next, userId)
          if (!clientId) continue
          next = ensureAgent(next, userId, msg.descriptor.mode, clientId, llmRef, ctx).state
        }

        return { state: next }
      },

      _agentUnregistered: (state, msg) => {
        const { [msg.mode]: _, ...descriptors } = state.descriptors
        return { state: { ...state, descriptors } }
      },

      _connected: (state, msg, ctx) => {
        const { clientId, userId } = msg
        if (state.clientIndex[clientId]) return { state }
        const existing = state.sessions[userId]
        const ts = Date.now()

        // Reuse existing per-user resources if this user already has a session.
        if (existing) {
          const newCount = existing.clientCount + 1
          const next = updateSession(state, userId, { clientCount: newCount })
          ctx.publish(SessionLifecycleTopic, {
            type:        'clientAttached',
            userId,
            clientId,
            clientCount: newCount,
            timestamp:   ts,
          })
          publishModeChanged(next, [clientId], existing.activeMode, ctx)
          return {
            state: { ...next, clientIndex: { ...next.clientIndex, [clientId]: userId } },
          }
        }

        // First connect for this userId — spawn history store + default agent.
        const historyStoreRef = ctx.spawn(`history-store-${userId}`, HistoryStore({ userId, historyWindowHours, workPath })) as ActorRef<HistoryStoreMsg>
        const seeded: Session = {
          historyStoreRef,
          agentRefs:   {},
          activeMode:  defaultMode,
          clientCount: 1,
        }
        const withSession = setSession(state, userId, seeded)
        const afterAgent  = ensureAgent(withSession, userId, defaultMode, clientId, llmRef, ctx)

        ctx.publish(SessionLifecycleTopic, {
          type:          'sessionStarted',
          userId,
          firstClientId: clientId,
          defaultMode,
          timestamp:     ts,
        })
        ctx.publish(SessionLifecycleTopic, {
          type:        'clientAttached',
          userId,
          clientId,
          clientCount: 1,
          timestamp:   ts,
        })
        publishModeChanged(afterAgent.state, [clientId], defaultMode, ctx)

        return {
          state: {
            ...afterAgent.state,
            clientIndex: { ...afterAgent.state.clientIndex, [clientId]: userId },
          },
        }
      },

      _disconnected: (state, msg, ctx) => {
        const { clientId } = msg
        const userId = userIdOfClient(state, clientId)
        if (!userId) return { state }

        const session = state.sessions[userId]
        if (!session) return { state }

        const { [clientId]: _, ...clientIndex } = state.clientIndex
        const count = session.clientCount - 1
        const ts    = Date.now()

        ctx.publish(SessionLifecycleTopic, {
          type:        'clientDetached',
          userId,
          clientId,
          clientCount: count,
          timestamp:   ts,
        })

        if (count > 0) {
          const next = updateSession({ ...state, clientIndex }, userId, { clientCount: count })
          return { state: next }
        }

        // Last client gone — tear down everything for this user.
        for (const ref of Object.values(session.agentRefs)) ctx.stop(ref)
        ctx.stop(session.historyStoreRef)
        const { [userId]: __, ...sessions } = state.sessions
        ctx.publish(SessionLifecycleTopic, {
          type:      'sessionEnded',
          userId,
          reason:    'lastDisconnect',
          timestamp: ts,
        })
        return { state: { ...state, sessions, clientIndex } }
      },

      _message: (state, msg) => {
        const { clientId, text, attachments, traceId, parentSpanId, isCron } = msg
        const userId = userIdOfClient(state, clientId)
        if (!userId) return { state }
        const session = state.sessions[userId]
        if (!session) return { state }
        const agent = session.agentRefs[session.activeMode]
        const headers = traceId && parentSpanId
          ? { traceparent: `00-${traceId}-${parentSpanId}-01` }
          : undefined
        agent?.send({ type: 'userMessage', clientId, text, attachments, isCron, isInjected: isCron }, headers)
        return { state }
      },

      _cronTrigger: (state, msg, ctx) => {
        const { userId, text, traceId, parentSpanId } = msg
        // Cron targets the default mode — avoid surprising a user who left a
        // non-default mode active.
        const session = state.sessions[userId]
        const agent   = session?.agentRefs[defaultMode]
        if (!agent) {
          ctx.log.warn('cron job fired but user not connected', { userId })
          return { state }
        }
        const clientId = Object.entries(state.clientIndex).find(([, uid]) => uid === userId)?.[0]
        if (!clientId) {
          ctx.log.warn('cron job fired but no clientId found for user', { userId })
          return { state }
        }
        const headers = traceId && parentSpanId
          ? { traceparent: `00-${traceId}-${parentSpanId}-01` }
          : undefined
        agent.send({ type: 'userMessage', clientId, text, isCron: true, isInjected: true }, headers)
        return { state }
      },

      _switchAgent: (state, msg, ctx) => {
        const { clientId, mode, source, reason } = msg
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

        const previousMode = state.sessions[userId]?.activeMode ?? mode

        // Ensure target agent exists, then mark it active.
        const afterAgent = ensureAgent(state, userId, mode, clientId, llmRef, ctx)
        if (!afterAgent.ref) return { state: afterAgent.state }

        const next = updateSession(afterAgent.state, userId, { activeMode: mode })

        publishModeChanged(next, clientIdsForUser(next, userId), mode, ctx)
        ctx.publish(SessionLifecycleTopic, {
          type:         'modeActivated',
          userId,
          mode,
          previousMode,
          source,
          timestamp:    Date.now(),
        })
        ctx.log.info('session-manager: agent switched', { userId, mode, reason })

        return { state: next }
      },
    }),

    supervision: { type: 'restart', maxRetries: 3, withinMs: 30_000 },
  }
}
