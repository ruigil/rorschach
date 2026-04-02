import type { ActorDef, ActorRef } from '../../system/types.ts'
import { onLifecycle, onMessage } from '../../system/match.ts'
import { WsConnectTopic, WsDisconnectTopic, WsMessageTopic } from '../../types/ws.ts'
import { createReActActor } from './react.ts'
import type { ReActState } from './react.ts'
import type { ToolFilter } from '../../types/tools.ts'
import type { ReActMsg } from '../../types/react.ts'
import type { LlmProviderMsg } from '../../types/llm.ts'

// ─── Message protocol ───

type SessionManagerMsg =
  | { type: '_connected';    clientId: string }
  | { type: '_disconnected'; clientId: string }
  | { type: '_message';      clientId: string; text: string; images?: string[]; audio?: string; traceId: string; parentSpanId: string }

// ─── State ───

type SessionManagerState = {
  sessions: Record<string, ActorRef<ReActMsg>>
}

// ─── Options ───

export type SessionManagerOptions = {
  llmRef:         ActorRef<LlmProviderMsg>
  model:          string
  systemPrompt?:  string
  historyWindow?: number
  toolFilter?:    ToolFilter
}

// ─── Initial ReAct state ───

const initialReActState = (llmRef: ActorRef<LlmProviderMsg>): ReActState => ({
  history:          [],
  tools:            {},
  modelInfo:        null,
  sessionUsage:     { promptTokens: 0, completionTokens: 0 },
  llmRef,
  userContext:      null,
  requestId:        null,
  turnMessages:     null,
  spanHandles:      null,
  pendingUsage:     { promptTokens: 0, completionTokens: 0 },
  pending:          '',
  pendingReasoning: '',
  pendingBatch:     null,
})

// ─── Actor definition ───

export const createSessionManagerActor = (options: SessionManagerOptions): ActorDef<SessionManagerMsg, SessionManagerState> => {
  const { llmRef, model, systemPrompt, historyWindow, toolFilter } = options

  return {
    lifecycle: onLifecycle({
      start: (state, context) => {
        context.subscribe(WsConnectTopic,    e => ({ type: '_connected'    as const, clientId: e.clientId }))
        context.subscribe(WsDisconnectTopic, e => ({ type: '_disconnected' as const, clientId: e.clientId }))
        context.subscribe(WsMessageTopic,    e => ({ type: '_message' as const, clientId: e.clientId, text: e.text, images: e.images, audio: e.audio, traceId: e.traceId, parentSpanId: e.parentSpanId }))
        return { state }
      },

      terminated: (state, event) => {
        // A ReAct child crashed — clean up its session entry
        const entry = Object.entries(state.sessions).find(([, ref]) => ref.name === event.ref.name)
        if (!entry) return { state }
        const [clientId] = entry
        const { [clientId]: _, ...rest } = state.sessions
        return { state: { ...state, sessions: rest } }
      },
    }),

    handler: onMessage<SessionManagerMsg, SessionManagerState>({
      _connected: (state, message, context) => {
        const { clientId } = message
        const ref = context.spawn(
          `react-${clientId}`,
          createReActActor({ clientId, model, systemPrompt, historyWindow, toolFilter }),
          initialReActState(llmRef),
        )
        return { state: { sessions: { ...state.sessions, [clientId]: ref } } }
      },

      _disconnected: (state, message, context) => {
        const { clientId } = message
        const ref = state.sessions[clientId]
        if (ref) context.stop(ref)
        const { [clientId]: _, ...rest } = state.sessions
        return { state: { sessions: rest } }
      },

      _message: (state, message) => {
        const { clientId, text, images, audio, traceId, parentSpanId } = message
        state.sessions[clientId]?.send({ type: 'userMessage', text, images, audio, traceId, parentSpanId })
        return { state }
      },
    }),

    supervision: { type: 'restart', maxRetries: 3, withinMs: 30_000 },
  }
}
