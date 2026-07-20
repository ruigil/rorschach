import type { ActorDef, ActorRef } from '../../system/index.ts'
import { onLifecycle, onMessage } from '../../system/index.ts'
import {
  UserPresenceTopic,
  InboundMessageTopic,
  type MessageAttachment,
  type UserPresenceEvent,
} from '../../types/events.ts'
import { LlmProviderTopic, type LlmProviderMsg } from '../../types/llm.ts'
import { ContextStore, type ContextStoreMsg } from './context-store.ts'
import { SessionLifecycleTopic } from './types.ts'
import { JobRegistryTopic, type JobLifecycleEvent } from '../../types/tools.ts'

// ─── Message protocol ──────────────────────────────────────────────────────

type SessionManagerMsg =
  | { type: '_userPresence';     event: UserPresenceEvent }
  | { type: '_message';          userId: string; text: string; attachments?: MessageAttachment[]; traceId: string; parentSpanId: string }
  | { type: '_jobRegistry';      event: JobLifecycleEvent }
  | { type: '_llmProvider';      ref: ActorRef<LlmProviderMsg> | null }

// ─── State ─────────────────────────────────────────────────────────────────

type Session = {
  contextStoreRef: ActorRef<ContextStoreMsg>
}

type SessionManagerState = {
  sessions:         Record<string, Session>         // userId → Session
  activeInterfaces: Record<string, Set<'http' | 'signal' | 'cli'>> // userId → Set of active interfaces
  activeJobs:       Record<string, { userId: string }> // jobId → info (to track when it is safe to tear down session)
  agentRegistryRef: ActorRef<any> | null
  llmRef:           ActorRef<LlmProviderMsg> | null
}

const initialSessionManagerState = (): SessionManagerState => ({
  sessions:         {},
  activeInterfaces: {},
  activeJobs:       {},
  agentRegistryRef: null,
  llmRef:           null,
})

// ─── Options ───────────────────────────────────────────────────────────────

export type SessionManagerOptions = {
  llmRef:              ActorRef<LlmProviderMsg>
  agentRegistryRef:    ActorRef<any>
  defaultMode:         string
  contextWindowHours?: number
}

// ─── Helpers ───────────────────────────────────────────────────────────────

const setSession = (state: SessionManagerState, userId: string, session: Session): SessionManagerState => ({
  ...state,
  sessions: { ...state.sessions, [userId]: session },
})

const removeSession = (state: SessionManagerState, userId: string): SessionManagerState => {
  const { [userId]: _, ...sessions } = state.sessions
  const { [userId]: __, ...activeInterfaces } = state.activeInterfaces
  return { ...state, sessions, activeInterfaces }
}

const tryDestroySession = (
  state: SessionManagerState,
  userId: string,
  ctx: any,
  ts: number,
): SessionManagerState => {
  const session = state.sessions[userId]
  if (!session) return state

  const hasActiveJobs = Object.values(state.activeJobs).some(job => job.userId === userId)
  const hasActiveInterfaces = state.activeInterfaces[userId] && state.activeInterfaces[userId].size > 0
  if (hasActiveInterfaces || hasActiveJobs) {
    return state
  }

  ctx.stop(session.contextStoreRef)

  const { [userId]: _, ...sessions } = state.sessions
  const { [userId]: __, ...activeInterfaces } = state.activeInterfaces

  ctx.publish(SessionLifecycleTopic, {
    type:      'sessionEnded',
    userId,
    reason:    'lastDisconnect',
    timestamp: ts,
  })

  return { ...state, sessions, activeInterfaces }
}

// ─── Actor ─────────────────────────────────────────────────────────────────

export const SessionManager = (
  options: SessionManagerOptions,
): ActorDef<SessionManagerMsg, SessionManagerState> => {
  const { llmRef, agentRegistryRef, defaultMode, contextWindowHours } = options

  return {
    initialState: initialSessionManagerState,
    lifecycle: onLifecycle({
      start: (state, ctx) => {
        ctx.subscribe(UserPresenceTopic, e => ({ type: '_userPresence' as const, event: e }))
        ctx.subscribe(InboundMessageTopic,   e => ({ type: '_message'      as const, userId: e.userId, text: e.text, attachments: e.attachments, traceId: e.traceId, parentSpanId: e.parentSpanId }))
        ctx.subscribe(JobRegistryTopic,      e => ({ type: '_jobRegistry'  as const, event: e }))
        ctx.subscribe(LlmProviderTopic,      event => ({ type: '_llmProvider' as const, ref: event.ref }))
        return { state: { ...state, agentRegistryRef: state.agentRegistryRef ?? agentRegistryRef, llmRef: state.llmRef ?? llmRef } }
      },

      terminated: (state, event, ctx) => {
        const deadName = event.ref.name
        // Context-store death cascades into a full session drop.
        for (const [userId, session] of Object.entries(state.sessions)) {
          if (session.contextStoreRef.name === deadName) {
            ctx.publish(SessionLifecycleTopic, {
              type:      'sessionEnded',
              userId,
              reason:    'contextStoreCrash',
              timestamp: Date.now(),
            })
            return { state: removeSession(state, userId) }
          }
        }
        return { state }
      },
    }),

    handler: onMessage<SessionManagerMsg, SessionManagerState>({
      _llmProvider: (state, msg) => {
        return { state: { ...state, llmRef: msg.ref } }
      },

      _userPresence: (state, msg, ctx) => {
        const { event } = msg
        const { userId, status, source } = event
        const ts = Date.now()

        const existingInterfaces = state.activeInterfaces[userId] || new Set<'http' | 'signal' | 'cli'>()

        if (status === 'present') {
          if (existingInterfaces.has(source)) return { state }

          const newInterfaces = new Set(existingInterfaces)
          newInterfaces.add(source)
          const nextInterfaces = { ...state.activeInterfaces, [userId]: newInterfaces }
          const nextState = { ...state, activeInterfaces: nextInterfaces }

          const existingSession = nextState.sessions[userId]

          if (existingSession) {
            ctx.publish(SessionLifecycleTopic, {
              type:      'presencePresent',
              userId,
              source,
              timestamp: ts,
            })
            return { state: nextState }
          }

          // First connect for this userId — spawn context store
          const contextStoreRef = ctx.spawn(`context-store-${userId}`, ContextStore({ userId, contextWindowHours })) as ActorRef<ContextStoreMsg>
          const seeded: Session = {
            contextStoreRef,
          }
          const withSession = setSession(nextState, userId, seeded)

          ctx.publish(SessionLifecycleTopic, {
            type:          'sessionStarted',
            userId,
            defaultMode,
            contextStoreRef,
            timestamp:     ts,
          })
          ctx.publish(SessionLifecycleTopic, {
            type:        'presencePresent',
            userId,
            source,
            timestamp:   ts,
          })

          return {
            state: withSession,
          }
        } else {
          // status === 'absent'
          if (!existingInterfaces.has(source)) return { state }

          const newInterfaces = new Set(existingInterfaces)
          newInterfaces.delete(source)

          const nextInterfaces = { ...state.activeInterfaces, [userId]: newInterfaces }
          const nextState = { ...state, activeInterfaces: nextInterfaces }

          ctx.publish(SessionLifecycleTopic, {
            type:        'presenceAbsent',
            userId,
            source,
            timestamp:   ts,
          })

          return { state: tryDestroySession(nextState, userId, ctx, ts) }
        }
      },

      _message: (state, msg) => {
        const { userId, text, attachments, traceId, parentSpanId } = msg
        const session = state.sessions[userId]
        if (!session) return { state }

        state.agentRegistryRef?.send({
          type: 'routeMessage',
          userId,
          text,
          attachments,
          traceId,
          parentSpanId,
        })
        return { state }
      },

      _jobRegistry: (state, msg, ctx) => {
        const { event } = msg
        if (event.status === 'running') {
          if (event.userId) {
            return {
              state: {
                ...state,
                activeJobs: {
                  ...state.activeJobs,
                  [event.jobId]: {
                    userId: event.userId,
                  },
                },
              },
            }
          }
          return { state }
        }

        if (event.status === 'completed' || event.status === 'failed' || event.status === 'cleared') {
          const cached = state.activeJobs[event.jobId]
          const { [event.jobId]: _, ...activeJobs } = state.activeJobs
          let next = { ...state, activeJobs }
          if (cached) {
            next = tryDestroySession(next, cached.userId, ctx, Date.now())
          }
          return { state: next }
        }

        return { state }
      },
    }),

    supervision: { type: 'restart', maxRetries: 3, withinMs: 30_000 },
  }
}
