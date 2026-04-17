import type { ActorDef, ActorRef } from '../../system/types.ts'
import { onLifecycle, onMessage } from '../../system/match.ts'
import { WsConnectTopic, WsDisconnectTopic, WsMessageTopic, CronTriggerTopic } from '../../types/ws.ts'
import { createChatbotActor } from './chatbot.ts'
import type { ChatbotState } from './chatbot.ts'
import type { ToolFilter } from '../../types/tools.ts'
import type { ChatbotMsg } from '../../types/chatbot.ts'
import type { LlmProviderMsg } from '../../types/llm.ts'
import type { PlannerInputMsg, PlannerConfig } from '../../types/planner.ts'
import { PlannerActiveTopic } from '../../types/planner.ts'

// ─── Message protocol ───

type SessionManagerMsg =
  | { type: '_connected';            clientId: string; userId: string | null; roles: string[] }
  | { type: '_disconnected';         clientId: string }
  | { type: '_message';              clientId: string; text: string; images?: string[]; audio?: string; pdfs?: string[]; traceId: string; parentSpanId: string; isCron?: boolean }
  | { type: '_cronTrigger';          userId: string; text: string; traceId: string; parentSpanId: string }
  | { type: '_plannerSessionUpdated'; clientId: string; plannerRef: ActorRef<PlannerInputMsg> | null; summary?: string }

// ─── State ───

type SessionManagerState = {
  userSessions:    Record<string, ActorRef<ChatbotMsg>>       // userId   → actor (authenticated)
  anonSessions:    Record<string, ActorRef<ChatbotMsg>>       // clientId → actor (anonymous)
  clientIndex:     Record<string, string>                     // clientId → userId (for routing & cleanup)
  activeClients:   Record<string, number>                     // userId   → active connection count
  plannerSessions: Record<string, ActorRef<PlannerInputMsg>>  // clientId → planner actor (active planning)
}

// ─── Options ───

export type SessionManagerOptions = {
  llmRef:         ActorRef<LlmProviderMsg>
  model:          string
  systemPrompt?:  string
  historyWindow?: number
  toolFilter?:    ToolFilter
  plannerConfig?: PlannerConfig
}

// ─── Initial chatbot state ───

const initialChatbotState = (llmRef: ActorRef<LlmProviderMsg>): ChatbotState => ({
  history:          [],
  tools:            {},
  sessionUsage:     { promptTokens: 0, completionTokens: 0 },
  llmRef,
  userContext:      null,
  activePlannerRef: null,
  requestId:        null,
  turnMessages:     null,
  spanHandles:      null,
  pendingUsage:     { promptTokens: 0, completionTokens: 0 },
  pending:          '',
  pendingReasoning: '',
  pendingBatch:     null,
  toolLoopCount:    0,
  activeClientId:   '',
})

// ─── Actor definition ───

export const createSessionManagerActor = (options: SessionManagerOptions): ActorDef<SessionManagerMsg, SessionManagerState> => {
  const { llmRef, model, systemPrompt, historyWindow, toolFilter, plannerConfig } = options

  return {
    lifecycle: onLifecycle({
      start: (state, context) => {
        context.subscribe(WsConnectTopic,    e => ({ type: '_connected'    as const, clientId: e.clientId, userId: e.userId, roles: e.roles }))
        context.subscribe(WsDisconnectTopic, e => ({ type: '_disconnected' as const, clientId: e.clientId }))
        context.subscribe(WsMessageTopic,    e => ({ type: '_message'      as const, clientId: e.clientId, text: e.text, images: e.images, audio: e.audio, pdfs: e.pdfs, traceId: e.traceId, parentSpanId: e.parentSpanId, isCron: e.isCron }))
        context.subscribe(CronTriggerTopic,  e => ({ type: '_cronTrigger'  as const, userId: e.userId, text: e.text, traceId: e.traceId, parentSpanId: e.parentSpanId }))
        context.subscribe(PlannerActiveTopic, e => ({ type: '_plannerSessionUpdated' as const, clientId: e.clientId, plannerRef: e.plannerRef ?? null, summary: 'summary' in e ? e.summary : undefined }))
        return { state }
      },

      terminated: (state, event) => {
        // Check userSessions
        const userEntry = Object.entries(state.userSessions).find(([, ref]) => ref.name === event.ref.name)
        if (userEntry) {
          const [userId] = userEntry
          const { [userId]: _, ...userSessions } = state.userSessions
          const clientIndex = Object.fromEntries(Object.entries(state.clientIndex).filter(([, uid]) => uid !== userId))
          const { [userId]: __, ...activeClients } = state.activeClients
          return { state: { ...state, userSessions, clientIndex, activeClients } }
        }
        // Check anonSessions
        const anonEntry = Object.entries(state.anonSessions).find(([, ref]) => ref.name === event.ref.name)
        if (anonEntry) {
          const [clientId] = anonEntry
          const { [clientId]: _, ...anonSessions } = state.anonSessions
          return { state: { ...state, anonSessions } }
        }
        return { state }
      },
    }),

    handler: onMessage<SessionManagerMsg, SessionManagerState>({
      _connected: (state, message, context) => {
        const { clientId, userId, roles } = message

        if (userId) {
          // Authenticated: key by userId, share actor across reconnects and channels
          const existing = state.userSessions[userId]
          if (existing) {
            return {
              state: {
                ...state,
                clientIndex:   { ...state.clientIndex,   [clientId]: userId },
                activeClients: { ...state.activeClients, [userId]: (state.activeClients[userId] ?? 0) + 1 },
              },
            }
          }
          const ref = context.spawn(
            `chatbot-${userId}`,
            createChatbotActor({ clientId, model, systemPrompt, historyWindow, toolFilter, plannerConfig, userId, roles, llmRef }),
            initialChatbotState(llmRef),
          )
          return {
            state: {
              ...state,
              userSessions:  { ...state.userSessions,  [userId]: ref },
              clientIndex:   { ...state.clientIndex,   [clientId]: userId },
              activeClients: { ...state.activeClients, [userId]: 1 },
            },
          }
        }

        // Anonymous: one actor per clientId (old behaviour)
        const ref = context.spawn(
          `chatbot-${clientId}`,
          createChatbotActor({ clientId, model, systemPrompt, historyWindow, toolFilter, plannerConfig }),
          initialChatbotState(llmRef),
        )
        return { state: { ...state, anonSessions: { ...state.anonSessions, [clientId]: ref } } }
      },

      _disconnected: (state, message, context) => {
        const { clientId } = message
        const userId = state.clientIndex[clientId]

        if (userId) {
          const count = (state.activeClients[userId] ?? 1) - 1
          const { [clientId]: _, ...clientIndex } = state.clientIndex
          if (count <= 0) {
            const ref = state.userSessions[userId]
            if (ref) context.stop(ref)
            const { [userId]: __, ...userSessions } = state.userSessions
            const { [userId]: ___, ...activeClients } = state.activeClients
            return { state: { ...state, userSessions, clientIndex, activeClients } }
          }
          return { state: { ...state, clientIndex, activeClients: { ...state.activeClients, [userId]: count } } }
        }

        // Anonymous
        const ref = state.anonSessions[clientId]
        if (ref) context.stop(ref)
        const { [clientId]: _, ...anonSessions } = state.anonSessions
        return { state: { ...state, anonSessions } }
      },

      _message: (state, message) => {
        const { clientId, text, images, audio, pdfs, traceId, parentSpanId, isCron } = message

        // If a planner session is active for this client, route input to the planner instead
        const plannerRef = state.plannerSessions[clientId]
        if (plannerRef) {
          plannerRef.send({ type: '_userInput', clientId, text })
          return { state }
        }

        const userId = state.clientIndex[clientId]
        const actor  = userId ? state.userSessions[userId] : state.anonSessions[clientId]
        actor?.send({ type: 'userMessage', clientId, text, images, audio, pdfs, traceId, parentSpanId, isCron })
        return { state }
      },

      _plannerSessionUpdated: (state, message) => {
        const { clientId, plannerRef, summary } = message

        if (plannerRef) {
          // Planner is starting a session for this clientId
          return { state: { ...state, plannerSessions: { ...state.plannerSessions, [clientId]: plannerRef } } }
        }

        // Planner is done — restore normal routing
        const { [clientId]: _, ...plannerSessions } = state.plannerSessions

        const userId     = state.clientIndex[clientId]
        const chatbotRef = userId ? state.userSessions[userId] : state.anonSessions[clientId]

        // Always tell the chatbot to clean up the planner actor
        chatbotRef?.send({ type: '_plannerDone' })

        if (summary) {
          // Inject summary as a synthetic userMessage so the chatbot replies naturally
          chatbotRef?.send({
            type:         'userMessage',
            clientId,
            text:         `[Planning session completed] ${summary}`,
            traceId:      crypto.randomUUID(),
            parentSpanId: crypto.randomUUID(),
          })
        }

        return { state: { ...state, plannerSessions } }
      },

      _cronTrigger: (state, message, context) => {
        const { userId, text, traceId, parentSpanId } = message
        const actor = state.userSessions[userId]
        if (!actor) {
          context.log.warn('cron job fired but user not connected', { userId })
          return { state }
        }
        // Find any active clientId for this user to use as the reply address
        const clientId = Object.entries(state.clientIndex).find(([, uid]) => uid === userId)?.[0]
        if (!clientId) {
          context.log.warn('cron job fired but no clientId found for user', { userId })
          return { state }
        }
        actor.send({ type: 'userMessage', clientId, text, traceId, parentSpanId, isCron: true })
        return { state }
      },
    }),

    supervision: { type: 'restart', maxRetries: 3, withinMs: 30_000 },
  }
}
