import type { ActorDef, ActorContext, ActorResult, Interceptor, ActorRef } from '../actor/types.ts'
import { onLifecycle } from '../actor/match.ts'
import { agentLoop, idleLoopState, type LoopState, type LoopMsg } from './agent-loop.ts'
import { assembleAgentMessages, assembleUserText, type ContextView } from './context-assembly.ts'
import { ContextSnapshotTopic, type AgentFactoryOpts, type AgentModelOptions, type AgentDescriptor } from '../../types/agents.ts'
import { ToolRegistrationTopic, type ToolCollection, type ToolFilter, type ToolMsg, type ToolSchema } from '../../types/tools.ts'
import { applyToolFilter } from './tool-utils.ts'
import { OutboundUserMessageTopic } from '../../types/events.ts'
import { LlmProviderTopic, type ApiMessage, type LlmProviderMsg } from '../../types/llm.ts'
import type { MessageAttachment } from '../../types/events.ts'
import type { ContextSnapshotEvent } from '../../types/agents.ts'

export type AgentExtra =
  | { type: 'userMessage'; text: string; attachments?: MessageAttachment[]; isInjected?: boolean }
  | ({ type: '_contextSnapshot' } & ContextSnapshotEvent)
  | { type: '_toolRegistered'; name: string; schema: ToolSchema; ref: ActorRef<ToolMsg>; mayBeLongRunning?: boolean }
  | { type: '_toolUnregistered'; name: string }
  | { type: '_llmProvider'; ref: ActorRef<LlmProviderMsg> | null }
  | { type: 'cancel' }

export type DefineAgentParams<OptionsType extends AgentModelOptions> = {
  role: string
  mode: string
  displayName: string
  shortDesc: string
  capabilities?: { userVisible: boolean }
  buildSystemPrompt: (options: OptionsType, state: any) => string
  defaultToolFilter?: ToolFilter
}

const emptyContextView = (userId = ''): ContextView => ({
  userId,
  version: 0,
  recentMessages: [],
  userContext: null,
  toolSummaries: [],
})

export const defineAgent = <
  OptionsType extends AgentModelOptions & { tools?: ToolCollection },
  MsgType extends LoopMsg<any>,
  StateType extends { loop: LoopState; contextView: ContextView; tools: ToolCollection }
>(
  params: DefineAgentParams<OptionsType>
) => {
  const {
    role,
    mode,
    displayName,
    shortDesc,
    capabilities,
    buildSystemPrompt,
    defaultToolFilter,
  } = params

  const spanName = `${mode}-agent`
  const logPrefix = `${mode}-agent`
  const errorMessages = {
    llm: `The ${mode} agent encountered an error. Please try again.`,
    loopLimit: `Tool loop limit reached in ${mode}. Please try again.`,
  }

  return (options: OptionsType): AgentDescriptor => {
    const factory = (opts: AgentFactoryOpts): ActorDef<MsgType, StateType> => {
      const { userId, contextStoreRef } = opts
    const maxToolLoops = options.maxToolLoops ?? 25

    type M = MsgType
    type S = StateType
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
      return {
        state: {
          ...state,
          tools: {
            ...state.tools,
            [msg.name]: { name: msg.name, schema: msg.schema, ref: msg.ref, mayBeLongRunning: msg.mayBeLongRunning },
          },
        },
      }
    }

    const handleToolUnregistered = (state: S, msg: any): ActorResult<M, S> => {
      const { [msg.name]: _, ...rest } = state.tools
      return { state: { ...state, tools: rest as ToolCollection } }
    }

    const buildTurnMessages = (state: S, userMsg: ApiMessage): ApiMessage[] =>
      assembleAgentMessages(state.contextView, {
        mode,
        systemPrompt: buildSystemPrompt(options, state),
        includeToolSummaries: true,
      }, userMsg)

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
      model: options.model,
      maxToolLoops,
      llmRef: (state: any) => state.llmRef,
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
        ;(state as any).llmRef = m.ref
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

      return next(state, msg)
    }

    return {
      initialState: () => ({
        loop: idleLoopState(),
        contextView: emptyContextView(userId),
        tools: { ...options.tools },
      }) as unknown as StateType,

      lifecycle: onLifecycle<M, S>({
        start: (state, ctx) => {
          ctx.subscribe(ContextSnapshotTopic, (event) => {
            if (event.userId !== userId) return null
            return { type: '_contextSnapshot' as const, ...event } as any
          })

          const filter = options.toolFilter ?? defaultToolFilter
          ctx.subscribe(ToolRegistrationTopic, (event) => {
            if (filter && !applyToolFilter(event.name, filter)) return null
            if ('schema' in event && event.ref) {
              return {
                type: '_toolRegistered' as const,
                name: event.name,
                schema: event.schema,
                ref: event.ref,
                mayBeLongRunning: event.mayBeLongRunning,
              } as any
            }
            return { type: '_toolUnregistered' as const, name: event.name } as any
          })

          ctx.subscribe(LlmProviderTopic, (event) => {
            return { type: '_llmProvider' as const, ref: event.ref } as any
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

  return {
    mode,
    displayName,
    shortDesc,
    capabilities: capabilities ?? { userVisible: true },
    factory,
  }
}
}
