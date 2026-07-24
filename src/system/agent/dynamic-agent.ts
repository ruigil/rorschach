import type { ActorDef, ActorContext, ActorResult, Interceptor, ActorRef } from '../actor/types.ts'
import { onLifecycle } from '../actor/match.ts'
import { agentLoop, idleLoopState, type LoopState } from './agent-loop.ts'
import { assembleAgentMessages, assembleUserText, getTodayDateString, getUserTimeContext, type ContextView } from './context-assembly.ts'
import { ContextSnapshotTopic, type AgentFactoryOpts, type AgentDescriptor } from '../../types/agents.ts'
import { ToolRegistrationTopic, type ToolCollection, type ToolFilter, type ToolMsg, type ToolSchema, type Tool } from '../../types/tools.ts'
import { applyToolFilter } from './tool-utils.ts'
import { OutboundUserMessageTopic } from '../../types/events.ts'
import { LlmProviderTopic, type ApiMessage, type LlmProviderMsg } from '../../types/llm.ts'
import type { MessageAttachment } from '../../types/events.ts'
import type { ContextSnapshotEvent } from '../../types/agents.ts'

export type DynamicAgentMsg =
  | { type: 'userMessage'; text: string; attachments?: MessageAttachment[]; isInjected?: boolean }
  | ({ type: '_contextSnapshot' } & ContextSnapshotEvent)
  | { type: '_toolRegistered'; name: string; schema: ToolSchema; ref: ActorRef<ToolMsg>; mayBeLongRunning?: boolean }
  | { type: '_toolUnregistered'; name: string }
  | { type: '_llmProvider'; ref: ActorRef<LlmProviderMsg> | null }
  | { type: '_updateDescriptor'; descriptor: AgentDescriptor }
  | { type: 'cancel' }

export type DynamicAgentState = {
  loop: LoopState
  contextView: ContextView
  descriptor?: AgentDescriptor
  globalTools?: ToolCollection
  tools: ToolCollection
  llmRef?: ActorRef<LlmProviderMsg> | null
}

const emptyContextView = (userId = ''): ContextView => ({
  userId,
  version: 0,
  recentMessages: [],
  userContext: null,
  toolSummaries: [],
})

const computeActiveTools = (
  internalTools: Tool[],
  globalTools: ToolCollection,
  toolFilter?: ToolFilter
): ToolCollection => {
  const tools: ToolCollection = {}
  // 1. Add global tools matching the current descriptor filter
  for (const [name, tool] of Object.entries(globalTools)) {
    if (!toolFilter || applyToolFilter(name, toolFilter)) {
      tools[name] = tool
    }
  }
  // 2. Override with internalTools (always prioritized)
  for (const t of internalTools) {
    tools[t.name] = t
  }
  return tools
}

export const DynamicAgentActor = (
  initialDescriptor: AgentDescriptor,
  opts: AgentFactoryOpts
): ActorDef<DynamicAgentMsg, DynamicAgentState> => {
  const { userId, contextStoreRef } = opts
  const mode = initialDescriptor.mode
  const role = initialDescriptor.role ?? 'reasoning'
  const spanName = `${mode}-agent`
  const logPrefix = `${mode}-agent`

  const errorMessages = {
    llm: `The ${mode} agent encountered an error. Please try again.`,
    loopLimit: `Tool loop limit reached in ${mode}. Please try again.`,
  }

  type M = DynamicAgentMsg
  type S = DynamicAgentState
  type Ctx = ActorContext<M>

  const handleContextSnapshot = (state: S, msg: any): ActorResult<M, S> => {
    return {
      state: {
        ...state,
        contextView: {
          userId: msg.userId,
          version: msg.version,
          recentMessages: msg.recentMessages,
          userContext: msg.userContext,
          toolSummaries: msg.toolSummaries,
        },
      },
    }
  }

  const handleToolRegistered = (state: S, msg: any): ActorResult<M, S> => {
    const desc = state.descriptor || initialDescriptor
    const globalTools = {
      ...(state.globalTools || {}),
      [msg.name]: { name: msg.name, schema: msg.schema, ref: msg.ref, mayBeLongRunning: msg.mayBeLongRunning },
    }
    const tools = computeActiveTools(desc.internalTools, globalTools, desc.toolFilter)
    return {
      state: {
        ...state,
        globalTools,
        tools,
      },
    }
  }

  const handleToolUnregistered = (state: S, msg: any): ActorResult<M, S> => {
    const desc = state.descriptor || initialDescriptor
    const { [msg.name]: _, ...globalTools } = state.globalTools || {}
    const tools = computeActiveTools(desc.internalTools, globalTools, desc.toolFilter)
    return {
      state: {
        ...state,
        globalTools,
        tools,
      },
    }
  }

  const buildTurnMessages = (state: S, userMsg: ApiMessage): ApiMessage[] => {
    const desc = state.descriptor || initialDescriptor
    const timeContext = getUserTimeContext(state.contextView.timezone ?? undefined)
    const identityNote = [
      `Active User: ${userId}`,
      `User Timezone: ${timeContext.timezone} (Offset: UTC${timeContext.offset})`,
      `Current Time: ${timeContext.dayOfWeek}, ${timeContext.formatted} (ISO: ${timeContext.iso})`
    ].join('\n')
    const fullPrompt = [desc.systemPrompt, identityNote].filter(Boolean).join('\n\n---\n\n')

    return assembleAgentMessages(state.contextView, {
      mode,
      systemPrompt: fullPrompt,
      includeToolSummaries: true,
    }, userMsg)
  }

  const handleUserMessage = (state: S, msg: any, ctx: Ctx): ActorResult<M, S> => {
    const userText = assembleUserText(msg.text, msg.attachments)
    const userMsg: ApiMessage = { role: 'user', content: userText }
    contextStoreRef.send({
      type: 'append',
      mode,
      source: 'user',
      injected: msg.isInjected || false,
      messages: [userMsg]
    })
    return loop.startTurn(state, {
      messages: buildTurnMessages(state, userMsg),
      userId,
    }, ctx)
  }

  const loop = agentLoop<S, M>({
    role,
    spanName,
    logPrefix,
    model: (state) => (state.descriptor || initialDescriptor).model,
    maxToolLoops: (state) => (state.descriptor || initialDescriptor).maxToolLoops ?? 25,
    llmRef: (state) => state.llmRef ?? null,
    tools: (state) => state.tools,
    uiEvents: OutboundUserMessageTopic,
    errorMessages,

    onComplete: (state, finalText) => {
      if (finalText) {
        contextStoreRef.send({
          type: 'append',
          mode,
          source: 'assistant',
          messages: [{ role: 'assistant', content: finalText }],
        })
      }
      return { state }
    },

    onError: (state, err, ctx) => {
      if (err.kind === 'loopLimit') {
        ctx.log.warn(`${logPrefix}: tool loop limit reached`)
      }
      return { state }
    },

    onBatchHistoryReady: (state, messages) => {
      contextStoreRef.send({ type: 'append', mode, messages })
      return { state }
    },

    onToolPending: (state, pending) => {
      const text = pending.placeholderText ?? `Background job started for ${pending.toolName} (jobId=${pending.jobId}).`
      contextStoreRef.send({
        type: 'append',
        mode,
        source: 'assistant',
        messages: [{ role: 'assistant', content: text }],
      })
      return { state }
    },
  })

  const hostInterceptor: Interceptor<M, S> = (state, msg, ctx, next) => {
    const m = msg as any

    if (m.type === '_llmProvider') {
      state.llmRef = m.ref
      return { state }
    }

    if (m.type === 'userMessage') {
      if (state.loop.phase !== 'idle') return { state, stash: true }
      return handleUserMessage(state, m, ctx)
    }

    if (m.type === 'cancel') {
      if (state.loop.phase === 'idle') return { state }
      return loop.cancelTurn(state, ctx)
    }

    if (m.type === '_toolRegistered') {
      return handleToolRegistered(state, m)
    }

    if (m.type === '_toolUnregistered') {
      return handleToolUnregistered(state, m)
    }

    if (m.type === '_contextSnapshot') {
      return handleContextSnapshot(state, m)
    }

    if (m.type === '_updateDescriptor') {
      const globalTools = state.globalTools || {}
      const tools = computeActiveTools(m.descriptor.internalTools, globalTools, m.descriptor.toolFilter)
      return {
        state: {
          ...state,
          descriptor: m.descriptor,
          tools,
        },
      }
    }

    return next(state, msg)
  }

  return {
    initialState: () => ({
      loop: idleLoopState(),
      contextView: emptyContextView(userId),
      descriptor: initialDescriptor,
      globalTools: {},
      tools: computeActiveTools(initialDescriptor.internalTools, {}, initialDescriptor.toolFilter),
      llmRef: null,
    }),

    lifecycle: onLifecycle<M, S>({
      start: (state, ctx) => {
        ctx.subscribe(ContextSnapshotTopic, (event) => {
          if (event.userId !== userId) return null
          return { type: '_contextSnapshot' as const, ...event }
        })

        ctx.subscribe(ToolRegistrationTopic, (event) => {
          if ('schema' in event && event.ref) {
            return {
              type: '_toolRegistered' as const,
              name: event.name,
              schema: event.schema,
              ref: event.ref,
              mayBeLongRunning: event.mayBeLongRunning,
            }
          }
          return { type: '_toolUnregistered' as const, name: event.name }
        })

        ctx.subscribe(LlmProviderTopic, (event) => {
          return { type: '_llmProvider' as const, ref: event.ref }
        })

        return { state }
      },
    }),

    handler: loop.idle,
    interceptors: [hostInterceptor],
    stashCapacity: 100,
    supervision: { type: 'restart', maxRetries: 3, withinMs: 30_000 },
  }
}
