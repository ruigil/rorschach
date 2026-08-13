import type { ActorDef, ActorRef } from '../../system/index.ts'
import { onLifecycle, onMessage, createTopic } from '../../system/index.ts'
import {
  UserPresenceTopic,
  InboundMessageTopic,
  OutboundUserMessageTopic,
  type MessageAttachment,
  type UserPresenceEvent,
} from '../../types/events.ts'
import { LlmProviderTopic, type LlmProviderMsg } from '../../types/llm.ts'
import { ContextStore, type ContextStoreMsg } from './context-store.ts'
import { SessionLifecycleTopic } from '../../types/session.ts'
import { JobRegistryTopic, type JobLifecycleEvent } from '../../types/tools.ts'
import type { AgentRegistryMsg } from './agent-registry.ts'
import type { StreamChunk, SCRReply } from '../../types/scr.ts'
import { invokeSCR } from '../../system/scr/invoker.ts'
import { requestStorage } from '../../system/context/request.ts'
import { ResolutionCache } from '../../system/scr/cache.ts'

// ─── Message protocol ──────────────────────────────────────────────────────

type SessionManagerMsg =
  | { type: '_userPresence';     event: UserPresenceEvent }
  | { type: '_message';          text: string; attachments?: MessageAttachment[] }
  | { type: '_streamChunk';      userId: string; event: StreamChunk }
  | { type: '_scrReply';         userId: string; streamToTopic: string; reply: SCRReply }
  | { type: '_jobRegistry';      event: JobLifecycleEvent }
  | { type: '_llmProvider';      ref: ActorRef<LlmProviderMsg> | null }

// ─── State ─────────────────────────────────────────────────────────────────

type Session = {
  contextStoreRef: ActorRef<ContextStoreMsg>
  timezone?: string
  permission?: any
}

type SessionManagerState = {
  sessions:         Record<string, Session>         // userId → Session
  activeInterfaces: Record<string, Set<'http' | 'signal' | 'cli'>> // userId → Set of active interfaces
  activeJobs:       Record<string, { userId: string }> // jobId → info (to track when it is safe to tear down session)
  agentRegistryRef: ActorRef<AgentRegistryMsg> | null
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
  agentRegistryRef:    ActorRef<AgentRegistryMsg>
  defaultMode:         string
  contextWindowHours?: number
  persistContext?:     boolean
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
  const { llmRef, agentRegistryRef, defaultMode, contextWindowHours, persistContext = false } = options

  return {
    initialState: initialSessionManagerState,
    lifecycle: onLifecycle({
      start: (state, ctx) => {
        ctx.subscribe(UserPresenceTopic, e => ({ type: '_userPresence' as const, event: e }))
        ctx.subscribe(InboundMessageTopic,   e => ({ type: '_message'      as const, text: e.text, attachments: e.attachments }))
        ctx.subscribe(JobRegistryTopic,      e => ({ type: '_jobRegistry'  as const, event: e }))
        ctx.subscribe(LlmProviderTopic,      event => ({ type: '_llmProvider' as const, ref: event.ref }))
        return { state: { ...state, agentRegistryRef: state.agentRegistryRef ?? agentRegistryRef, llmRef: state.llmRef ?? llmRef } }
      },

      watchStatus: (state, event, ctx) => {
        if (event.status !== 'terminated') return { state }
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
            if (event.timezone) {
              existingSession.contextStoreRef.send({ type: 'setTimezone', timezone: event.timezone })
              existingSession.timezone = event.timezone
            }
            if (event.permission) {
              existingSession.permission = event.permission
            }
            ctx.publish(SessionLifecycleTopic, {
              type:      'presencePresent',
              userId,
              source,
              timestamp: ts,
            })
            return { state: nextState }
          }

          // First connect for this userId — spawn context store
          const contextStoreRef = ctx.spawn(`context-store-${userId}`, ContextStore({
            userId,
            contextWindowHours,
            persistContext,
          })) as ActorRef<ContextStoreMsg>
          if (event.timezone) {
            contextStoreRef.send({ type: 'setTimezone', timezone: event.timezone })
          }
          const seeded: Session = {
            contextStoreRef,
            timezone: event.timezone,
            permission: event.permission,
          }
          const withSession = setSession(nextState, userId, seeded)

          ctx.publish(SessionLifecycleTopic, {
            type:          'sessionStarted',
            userId,
            defaultMode,
            contextStoreRef,
            permissionContext: event.permission ?? { grants: ['*'] },
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

      _message: (state, msg, ctx) => {
        const userId = ctx.request.userId
        const session = state.sessions[userId]
        if (!session) return { state }

        const hasChatbotUrn = ResolutionCache.getDescriptor('scr:reasoner:cognitive.chatbot') !== undefined

        if (hasChatbotUrn) {
          const streamToTopic = `session.stream.${userId}`

          ctx.subscribe(createTopic<StreamChunk>(streamToTopic), (event) => ({
            type: '_streamChunk' as const,
            userId,
            event,
          }), streamToTopic)

          const request = {
            ...ctx.request,
            streamTo: streamToTopic,
            timezone: session.timezone,
            permission: session.permission,
          }

          ctx.pipeToSelf(
            requestStorage.run(request, () =>
              invokeSCR('scr:reasoner:cognitive.chatbot', { prompt: msg.text })
            ),
            (reply) => ({
              type: '_scrReply' as const,
              userId,
              streamToTopic,
              reply,
            }),
            (error) => ({
              type: '_scrReply' as const,
              userId,
              streamToTopic,
              reply: { type: 'error', error: String(error) },
            })
          )
        } else if (state.agentRegistryRef) {
          // ⚠️ TEMPORARY COMPATIBILITY FALLBACK: Legacy AgentRegistry Message Routing
          // Falls back to routing to legacy mode-based session agents if URN is not registered.
          // Decommission and remove in Phase 5 when legacy agent registry is fully deleted (Task 5.5).
          ctx.send(state.agentRegistryRef, {
            type: 'routeMessage',
            text: msg.text,
            attachments: msg.attachments,
          })
        }
        return { state }
      },

      // ⚠️ TEMPORARY COMPATIBILITY BRIDGE: StreamChunk to OutboundUserMessageTopic Translator
      // Maps structured StreamChunk event payloads from SCR runs into legacy JSON frames 
      // expected by client WebSocket/HTTP connections.
      // Decommission and remove in Phase 5 when the frontend parses StreamChunks directly (Task 5.3).
      _streamChunk: (state, msg, ctx) => {
        const { userId, event } = msg
        if (event.type === 'start') {
          ctx.publish(OutboundUserMessageTopic, {
            userId,
            text: JSON.stringify({ type: 'start' }),
          })
        } else if (event.type === 'chunk') {
          const chunk = (event as any).chunk
          if (chunk.kind === 'text') {
            ctx.publish(OutboundUserMessageTopic, {
              userId,
              text: JSON.stringify({ type: 'chunk', text: chunk.text }),
            })
          } else if (chunk.kind === 'reasoning') {
            ctx.publish(OutboundUserMessageTopic, {
              userId,
              text: JSON.stringify({ type: 'reasoningChunk', text: chunk.text }),
            })
          }
        } else if (event.type === 'end') {
          ctx.publish(OutboundUserMessageTopic, {
            userId,
            text: JSON.stringify({ type: 'done' }),
          })
        } else if (event.type === 'error') {
          ctx.publish(OutboundUserMessageTopic, {
            userId,
            text: JSON.stringify({ type: 'error', text: event.error }),
          })
        }
        return { state }
      },

      // ⚠️ TEMPORARY COMPATIBILITY BRIDGE: Cleanup for invokeSCR runner replies
      // Cleans up local stream topics and translates end-of-turn metadata.
      // Decommission and remove in Phase 5 when local session stream translation is deprecated.
      _scrReply: (state, msg, ctx) => {
        const { userId, streamToTopic, reply } = msg

        ctx.unsubscribe(createTopic<StreamChunk>(streamToTopic), streamToTopic)
        ctx.deleteTopic(createTopic<StreamChunk>(streamToTopic))

        if (reply.type === 'error') {
          ctx.publish(OutboundUserMessageTopic, {
            userId,
            text: JSON.stringify({ type: 'error', text: reply.error }),
          })
        } else if (reply.type === 'pending') {
          ctx.publish(OutboundUserMessageTopic, {
            userId,
            text: JSON.stringify({
              type: 'chunk',
              text: reply.placeholderText ?? `Background job started (jobId=${reply.jobId}).`
            }),
          })
          ctx.publish(OutboundUserMessageTopic, {
            userId,
            text: JSON.stringify({ type: 'done' }),
          })
        }
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
