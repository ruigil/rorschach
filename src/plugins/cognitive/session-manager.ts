import type { ActorDef, ActorRef } from '../../system/index.ts'
import { onLifecycle, onMessage, DynamicAgentActor } from '../../system/index.ts'
import {
  UserPresenceTopic,
  InboundMessageTopic,
  CronTriggerTopic,
  OutboundUserMessageTopic,
  HttpWsFrameTopic,
  type MessageAttachment,
  type UserPresenceEvent,
  type HttpWsFrameEvent,
} from '../../types/events.ts'
import { LlmProviderTopic, type LlmProviderMsg } from '../../types/llm.ts'
import { ContextStore, type ContextStoreMsg} from './context-store.ts'
import {
  AgentRegistrationTopic,
  type AgentDescriptor,
  type AgentFactoryOpts,
} from '../../types/agents.ts'
import { SessionLifecycleTopic, SwitchAgentTopic } from './types.ts'
import { JobRegistryTopic, type JobLifecycleEvent } from '../../types/tools.ts'

// ─── Message protocol ──────────────────────────────────────────────────────

type SessionManagerMsg =
  | { type: '_userPresence';     event: UserPresenceEvent }
  | { type: '_message';          userId: string; text: string; attachments?: MessageAttachment[]; traceId: string; parentSpanId: string }
  | { type: '_cronTrigger';      userId: string; text: string; traceId: string; parentSpanId: string }
  | { type: '_agentRegistered';  descriptor: AgentDescriptor }
  | { type: '_agentUnregistered'; mode: string }
  | { type: '_switchAgent';      userId: string; mode: string; source: 'user' | 'llm' | 'programmatic'; reason?: string }
  | { type: '_jobRegistry';      event: JobLifecycleEvent }
  | { type: '_llmProvider';      ref: ActorRef<LlmProviderMsg> | null }
  | { type: '_wsFrame';          event: HttpWsFrameEvent }

// ─── State ─────────────────────────────────────────────────────────────────
//
// One Session record per active userId. Agents are spawned lazily on first
// activation of a (userId, mode) pair. activeInterfaces tracks which interface
// channels currently have active connections for the userId — the session is torn
// down when it hits zero.

type Session = {
  contextStoreRef: ActorRef<ContextStoreMsg>
  agentRefs:       Record<string, ActorRef<any>>   // mode → agent
  activeMode:      string
}

type SessionManagerState = {
  descriptors:      Record<string, AgentDescriptor> // mode → descriptor (catalog mirror)
  sessions:         Record<string, Session>         // userId → Session
  activeInterfaces: Record<string, Set<'http' | 'signal' | 'cli'>> // userId → Set of active interfaces
  activeJobs:       Record<string, { userId: string; toolName: string }> // jobId → info
  llmRef:           ActorRef<LlmProviderMsg> | null
}

const initialSessionManagerState = (): SessionManagerState => ({
  descriptors:      {},
  sessions:         {},
  activeInterfaces: {},
  activeJobs:       {},
  llmRef:           null,
})

// ─── Options ───────────────────────────────────────────────────────────────

export type SessionManagerOptions = {
  llmRef:              ActorRef<LlmProviderMsg>
  defaultMode:         string                   // resolved by the plugin; first-connect / cron / fallback target
  contextWindowHours?: number
  contextPath?:        string
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

  for (const ref of Object.values(session.agentRefs)) {
    ctx.stop(ref)
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

const ensureAgent = (
  state: SessionManagerState,
  userId: string,
  mode: string,
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
    contextStoreRef: session.contextStoreRef,
  }
  const ref = ctx.spawn(`${mode}-${userId}`, DynamicAgentActor(descriptor, opts)) as ActorRef<any>

  return {
    state: updateSession(state, userId, {
      agentRefs: { ...session.agentRefs, [mode]: ref },
    }),
    ref,
  }
}

const publishModeChanged = (
  userId: string,
  mode: string,
  state: SessionManagerState,
  ctx: any,
) => {
  const descriptor = state.descriptors[mode]
  const displayName = descriptor?.displayName ?? mode
  ctx.publish(OutboundUserMessageTopic, {
    userId,
    text: JSON.stringify({ type: 'modeChanged', mode, displayName }),
  })
}

// ─── Actor ─────────────────────────────────────────────────────────────────

export const SessionManager = (
  options: SessionManagerOptions,
): ActorDef<SessionManagerMsg, SessionManagerState> => {
  const { llmRef, defaultMode, contextWindowHours, contextPath } = options

  return {
    initialState: initialSessionManagerState,
    lifecycle: onLifecycle({
      start: (state, ctx) => {
        ctx.subscribe(UserPresenceTopic, e => ({ type: '_userPresence' as const, event: e }))
        ctx.subscribe(InboundMessageTopic,   e => ({ type: '_message'      as const, userId: e.userId, text: e.text, attachments: e.attachments, traceId: e.traceId, parentSpanId: e.parentSpanId }))
        ctx.subscribe(CronTriggerTopic,      e => ({ type: '_cronTrigger'  as const, userId: e.userId, text: e.text, traceId: e.traceId, parentSpanId: e.parentSpanId }))
        ctx.subscribe(AgentRegistrationTopic, e =>
          e.type === 'register'
            ? { type: '_agentRegistered'   as const, descriptor: e.descriptor }
            : { type: '_agentUnregistered' as const, mode:       e.mode },
        )
        ctx.subscribe(SwitchAgentTopic,      e => ({ type: '_switchAgent'  as const, userId: e.userId, mode: e.mode, source: e.source, reason: e.reason }))
        ctx.subscribe(JobRegistryTopic,      e => ({ type: '_jobRegistry'  as const, event: e }))
        ctx.subscribe(LlmProviderTopic,      event => ({ type: '_llmProvider' as const, ref: event.ref }))
        ctx.subscribe(HttpWsFrameTopic,      e => ({ type: '_wsFrame'      as const, event: e }))
        return { state: { ...state, llmRef: state.llmRef ?? llmRef } }
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
        // Agent death: remove from its session, and fall back to defaultMode if it was active.
        for (const [userId, session] of Object.entries(state.sessions)) {
          for (const [mode, ref] of Object.entries(session.agentRefs)) {
            if (ref.name === deadName) {
              const { [mode]: _, ...remaining } = session.agentRefs
              const patch: Partial<Session> = { agentRefs: remaining }
              if (session.activeMode === mode) {
                patch.activeMode = defaultMode
                publishModeChanged(userId, defaultMode, state, ctx)
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

      _llmProvider: (state, msg) => {
        return { state: { ...state, llmRef: msg.ref } }
      },

      _agentRegistered: (state, msg, ctx) => {
        let next: SessionManagerState = {
          ...state,
          descriptors: { ...state.descriptors, [msg.descriptor.mode]: msg.descriptor },
        }

        for (const [userId, session] of Object.entries(next.sessions)) {
          const existingRef = session.agentRefs[msg.descriptor.mode]
          if (existingRef) {
            existingRef.send({ type: '_updateDescriptor', descriptor: msg.descriptor })
          } else if (session.activeMode === msg.descriptor.mode) {
            next = ensureAgent(next, userId, msg.descriptor.mode, ctx).state
          }
        }

        return { state: next }
      },

      _agentUnregistered: (state, msg) => {
        const { [msg.mode]: _, ...descriptors } = state.descriptors
        return { state: { ...state, descriptors } }
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
            publishModeChanged(userId, existingSession.activeMode, nextState, ctx)
            return { state: nextState }
          }

          // First connect for this userId — spawn context store + default agent.
          const contextStoreRef = ctx.spawn(`context-store-${userId}`, ContextStore({ userId, contextWindowHours, contextPath })) as ActorRef<ContextStoreMsg>
          const seeded: Session = {
            contextStoreRef,
            agentRefs:   {},
            activeMode:  defaultMode,
          }
          const withSession = setSession(nextState, userId, seeded)
          const afterAgent  = ensureAgent(withSession, userId, defaultMode, ctx)

          ctx.publish(SessionLifecycleTopic, {
            type:          'sessionStarted',
            userId,
            defaultMode,
            timestamp:     ts,
          })
          ctx.publish(SessionLifecycleTopic, {
            type:        'presencePresent',
            userId,
            source,
            timestamp:   ts,
          })
          publishModeChanged(userId, defaultMode, afterAgent.state, ctx)

          return {
            state: afterAgent.state,
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
        const agent = session.agentRefs[session.activeMode]
        const headers = traceId && parentSpanId
          ? { traceparent: `00-${traceId}-${parentSpanId}-01` }
          : undefined
        agent?.send({ type: 'userMessage', text, attachments }, headers)
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
        const headers = traceId && parentSpanId
          ? { traceparent: `00-${traceId}-${parentSpanId}-01` }
          : undefined
        const formattedText = `[Internal Instruction] ${text}`
        agent.send({ type: 'userMessage', text: formattedText, isInjected: true }, headers)
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
                    toolName: event.toolName,
                  },
                },
              },
            }
          }
          return { state }
        }

        if (event.status === 'completed' || event.status === 'failed') {
          const cached = state.activeJobs[event.jobId]
          if (!cached) return { state }

          const { userId, toolName } = cached

          // Format out-of-band text
          const resultText = event.status === 'completed'
            ? (event.result?.text ?? 'Success')
            : (event.error ?? 'Unknown error')

          const userText = `[Background tool result — ${toolName}]: ${resultText}`

          // 1. Publish sources and attachments outbound directly
          if (event.status === 'completed' && event.result) {
            if (event.result.sources?.length) {
              ctx.publish(OutboundUserMessageTopic, {
                userId,
                text: JSON.stringify({ type: 'sources', sources: event.result.sources }),
              })
            }
            if (event.result.attachments?.length) {
              ctx.publish(OutboundUserMessageTopic, {
                userId,
                text: JSON.stringify({ type: 'attachments', attachments: event.result.attachments }),
              })
            }
          }

          // 2. Clear retained topic entry
          ctx.publishRetained(JobRegistryTopic, event.jobId, { jobId: event.jobId, status: 'cleared' })

          // 3. Inject back into the active agent for that session
          const session = state.sessions[userId]
          const mode = session?.activeMode ?? defaultMode
          const agent = session?.agentRefs[mode]

          if (agent) {
            agent.send({ type: 'userMessage', text: userText, isInjected: true })
          } else {
            ctx.log.warn('job completion but no agent found to inject into', { userId, mode, jobId: event.jobId })
          }

          // 4. Remove from active jobs cache
          const { [event.jobId]: _, ...activeJobs } = state.activeJobs
          const next = {
            ...state,
            activeJobs,
          }
          return { state: tryDestroySession(next, userId, ctx, Date.now()) }
        }

        if (event.status === 'cleared') {
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

      _switchAgent: (state, msg, ctx) => {
        const { userId, mode, source, reason } = msg
        const session = state.sessions[userId]
        if (!session) {
          ctx.log.warn('switchAgent: unknown userId', { userId, mode })
          return { state }
        }

        const descriptor = state.descriptors[mode]
        if (!descriptor) {
          ctx.log.warn('switchAgent: unknown mode', { userId, mode })
          ctx.publish(OutboundUserMessageTopic, {
            userId,
            text: JSON.stringify({ type: 'error', text: `Unknown agent mode: ${mode}` }),
          })
          return { state }
        }

        const previousMode = session.activeMode

        // Ensure target agent exists, then mark it active.
        const afterAgent = ensureAgent(state, userId, mode, ctx)
        if (!afterAgent.ref) return { state: afterAgent.state }

        const next = updateSession(afterAgent.state, userId, { activeMode: mode })

        publishModeChanged(userId, mode, next, ctx)
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
      
      _wsFrame: (state, msg, ctx) => {
        const { userId, frame } = msg.event
        if (!frame.type.startsWith('cognitive.')) return { state }

        if (frame.type === 'cognitive.switchMode') {
          ctx.publish(SwitchAgentTopic, { userId, mode: frame.mode, source: 'user' })
        }

        if (frame.type === 'cognitive.cancel') {
          const session = state.sessions[userId]
          if (session) {
            const agent = session.agentRefs[session.activeMode]
            if (agent) {
              agent.send({ type: 'cancel' })
            }
          }
        }

        if (frame.type === 'cognitive.listAgents') {
          const agents = Object.values(state.descriptors).map(d => ({
            mode: d.mode,
            displayName: d.displayName,
            shortDesc: d.shortDesc,
          }))
          ctx.publish(OutboundUserMessageTopic, {
            userId,
            text: JSON.stringify({ type: 'agents', agents }),
          })
        }
        return { state }
      },
    }),

    supervision: { type: 'restart', maxRetries: 3, withinMs: 30_000 },
  }
}
