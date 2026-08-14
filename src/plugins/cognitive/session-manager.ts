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
import { ContextSnapshotTopic, type ContextSnapshotEvent } from '../../types/agents.ts'
import type { ContextView } from '../../system/index.ts'
import type { StreamChunk, SCRReply } from '../../types/scr.ts'
import { invokeSCR } from '../../system/scr/invoker.ts'
import { requestStorage } from '../../system/context/request.ts'
import { ResolutionCache } from '../../system/scr/cache.ts'

// ─── Message protocol ──────────────────────────────────────────────────────

type SessionManagerMsg =
  | { type: '_userPresence';     event: UserPresenceEvent }
  | { type: '_contextSnapshot';  event: ContextSnapshotEvent }
  | { type: '_message';          text: string; attachments?: MessageAttachment[] }
  | { type: '_streamChunk';      userId: string; event: StreamChunk }
  | { type: '_scrReply';         userId: string; userText: string; streamToTopic: string; reply: SCRReply }
  | { type: '_llmProvider';      ref: ActorRef<LlmProviderMsg> | null }

// ─── State ─────────────────────────────────────────────────────────────────

type UserSession = {
  contextStoreRef: ActorRef<ContextStoreMsg>
  timezone?: string
  permission?: any
}

type SessionManagerState = {
  userSessions:     Record<string, UserSession>         // userId → UserSession
  snapshots:        Record<string, ContextSnapshotEvent> // userId → Latest ContextSnapshotEvent
  llmRef:           ActorRef<LlmProviderMsg> | null
}

const initialSessionManagerState = (): SessionManagerState => ({
  userSessions:     {},
  snapshots:        {},
  llmRef:           null,
})

// ─── Options ───────────────────────────────────────────────────────────────

export type SessionManagerOptions = {
  llmRef:              ActorRef<LlmProviderMsg>
  defaultMode:         string
  contextWindowHours?: number
  persistContext?:     boolean
}

// ─── Actor ─────────────────────────────────────────────────────────────────

export const SessionManager = (
  options: SessionManagerOptions,
): ActorDef<SessionManagerMsg, SessionManagerState> => {
  const { llmRef, defaultMode, contextWindowHours, persistContext = false } = options

  const getOrCreateUserSession = (
    state: SessionManagerState,
    userId: string,
    ctx: any,
    eventInfo?: { timezone?: string; permission?: any },
  ): { session: UserSession; nextState: SessionManagerState; isNew: boolean } => {
    let session = state.userSessions[userId]
    if (session) {
      if (eventInfo?.timezone && eventInfo.timezone !== session.timezone) {
        session.contextStoreRef.send({ type: 'setTimezone', timezone: eventInfo.timezone })
        session.timezone = eventInfo.timezone
      }
      if (eventInfo?.permission) {
        session.permission = eventInfo.permission
      }
      return { session, nextState: state, isNew: false }
    }

    const contextStoreRef = ctx.spawn(`context-store-${userId}`, ContextStore({
      userId,
      contextWindowHours,
      persistContext,
    })) as ActorRef<ContextStoreMsg>

    if (eventInfo?.timezone) {
      contextStoreRef.send({ type: 'setTimezone', timezone: eventInfo.timezone })
    }

    const newSession: UserSession = {
      contextStoreRef,
      timezone: eventInfo?.timezone,
      permission: eventInfo?.permission,
    }

    const nextState: SessionManagerState = {
      ...state,
      userSessions: {
        ...state.userSessions,
        [userId]: newSession,
      },
    }

    return { session: newSession, nextState, isNew: true }
  }

  return {
    initialState: initialSessionManagerState,
    lifecycle: onLifecycle({
      start: (state, ctx) => {
        ctx.subscribe(UserPresenceTopic, e => ({ type: '_userPresence' as const, event: e }))
        ctx.subscribe(InboundMessageTopic, e => ({ type: '_message' as const, text: e.text, attachments: e.attachments }))
        ctx.subscribe(ContextSnapshotTopic, e => ({ type: '_contextSnapshot' as const, event: e }))
        ctx.subscribe(LlmProviderTopic, event => ({ type: '_llmProvider' as const, ref: event.ref }))
        return { state: { ...state, llmRef: state.llmRef ?? llmRef } }
      },

      watchStatus: (state, event, ctx) => {
        if (event.status !== 'terminated') return { state }
        const deadName = event.ref.name
        for (const [userId, session] of Object.entries(state.userSessions)) {
          if (session.contextStoreRef.name === deadName) {
            ctx.publish(SessionLifecycleTopic, {
              type:      'sessionEnded',
              userId,
              reason:    'contextStoreCrash',
              timestamp: Date.now(),
            })
            const { [userId]: _, ...userSessions } = state.userSessions
            return { state: { ...state, userSessions } }
          }
        }
        return { state }
      },
    }),

    handler: onMessage<SessionManagerMsg, SessionManagerState>({
      _llmProvider: (state, msg) => {
        return { state: { ...state, llmRef: msg.ref } }
      },

      _contextSnapshot: (state, msg) => {
        return {
          state: {
            ...state,
            snapshots: {
              ...state.snapshots,
              [msg.event.userId]: msg.event,
            },
          },
        }
      },

      _userPresence: (state, msg, ctx) => {
        const { event } = msg
        const { userId, status, source } = event
        const ts = Date.now()

        if (status === 'present') {
          const { session, nextState, isNew } = getOrCreateUserSession(state, userId, ctx, {
            timezone: event.timezone,
            permission: event.permission,
          })

          if (isNew) {
            ctx.publish(SessionLifecycleTopic, {
              type:              'sessionStarted',
              userId,
              defaultMode,
              contextStoreRef:   session.contextStoreRef,
              permissionContext: event.permission ?? { grants: ['*'] },
              timestamp:         ts,
            })
          }

          ctx.publish(SessionLifecycleTopic, {
            type:      'presencePresent',
            userId,
            source,
            timestamp: ts,
          })

          return { state: nextState }
        } else {
          // status === 'absent'
          ctx.publish(SessionLifecycleTopic, {
            type:        'presenceAbsent',
            userId,
            source,
            timestamp:   ts,
          })

          // User context persists in KV / ContextStore across disconnects
          return { state }
        }
      },

      _message: (state, msg, ctx) => {
        const userId = ctx.request.userId || 'system'
        const { session, nextState } = getOrCreateUserSession(state, userId, ctx)

        const hasChatbotUrn = ResolutionCache.getDescriptor('scr:reasoner:cognitive.chatbot') !== undefined

        if (hasChatbotUrn) {
          const streamToTopic = `session.stream.${userId}`

          ctx.subscribe(createTopic<StreamChunk>(streamToTopic), (event) => ({
            type: '_streamChunk' as const,
            userId,
            event,
          }), streamToTopic)

          const snapshot = nextState.snapshots[userId]
          const contextView: ContextView | undefined = snapshot ? {
            userId,
            version:       snapshot.version,
            recentMessages: snapshot.recentMessages,
            userContext:   snapshot.userContext,
            toolSummaries: snapshot.toolSummaries,
            timezone:      snapshot.timezone ?? session.timezone,
          } : undefined

          const request = {
            ...ctx.request,
            streamTo: streamToTopic,
            timezone: session.timezone ?? ctx.request.timezone,
            permission: session.permission ?? ctx.request.permission,
          }

          ctx.pipeToSelf(
            requestStorage.run(request, () =>
              invokeSCR('scr:reasoner:cognitive.chatbot', {
                prompt: msg.text,
                history: snapshot?.recentMessages ?? [],
                contextView,
              })
            ),
            (reply) => ({
              type: '_scrReply' as const,
              userId,
              userText: msg.text,
              streamToTopic,
              reply,
            }),
            (error) => ({
              type: '_scrReply' as const,
              userId,
              userText: msg.text,
              streamToTopic,
              reply: { type: 'error', error: String(error) },
            })
          )
        } else {
          ctx.log.error('Root chatbot agent URN scr:reasoner:cognitive.chatbot is not registered!')
        }
        return { state: nextState }
      },

      _streamChunk: (state, msg, ctx) => {
        const { userId, event } = msg
        ctx.publish(OutboundUserMessageTopic, {
          userId,
          text: JSON.stringify(event),
        })
        return { state }
      },

      _scrReply: (state, msg, ctx) => {
        const { streamToTopic, userId, userText, reply } = msg
        ctx.unsubscribe(createTopic<StreamChunk>(streamToTopic), streamToTopic)
        ctx.deleteTopic(createTopic<StreamChunk>(streamToTopic))

        if (reply.type === 'result') {
          let assistantText = ''
          const out = reply.output
          if (typeof out === 'string') {
            assistantText = out
          } else if (out && typeof out === 'object' && 'text' in out) {
            assistantText = String((out as any).text)
          } else if (out !== undefined && out !== null) {
            assistantText = JSON.stringify(out)
          }

          const session = state.userSessions[userId]
          if (session && assistantText) {
            session.contextStoreRef.send({
              type: 'append',
              mode: 'chatbot',
              messages: [
                { role: 'user', content: userText },
                { role: 'assistant', content: assistantText },
              ],
            })
          }
        }

        return { state }
      },
    }),

    supervision: { type: 'restart', maxRetries: 3, withinMs: 30_000 },
  }
}
