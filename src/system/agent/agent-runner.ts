import type { ActorDef, ActorRef, ActorContext, Interceptor, ActorResult } from '../actor/types.ts'
import { onLifecycle, onMessage } from '../actor/match.ts'
import { agentLoop, idleLoopState } from './agent-loop.ts'
import type { LoopState, LoopBaseMsg } from './agent-loop.ts'
import type { SCRReply, StreamChunk } from '../../types/scr.ts'
import { UsageUpdateTopic } from '../../types/scr.ts'
import type { LlmProviderMsg, ApiMessage } from '../../types/llm.ts'
import { LlmProviderTopic, CostTopic, type CostEvent } from '../../types/llm.ts'
import type { MessageRequest } from '../context/request.ts'
import { requestStorage } from '../context/request.ts'
import { createTopic } from '../actor/types.ts'
import { ResolutionCache } from '../scr/cache.ts'
import { authorize } from '../permissions/evaluator.ts'
import { getUserTimeContext } from './context-assembly.ts'
import { PersistenceProviderTopic, type PersistenceMsg } from '../../types/persistence.ts'
import { persistencePluginAdapter } from '../persistence.ts'
import type { ToolCollection } from '../../types/tools.ts'

export type SCRAgentRunnerMsg =
  | LoopBaseMsg
  | { type: 'start' }
  | { type: '_llmProvider'; ref: ActorRef<LlmProviderMsg> | null }
  | { type: '_persistenceProvider'; ref: ActorRef<PersistenceMsg> | null }
  | { type: '_costUpdate'; event: CostEvent }

export type SCRAgentRunnerState = {
  runId: string
  urn: string
  input: any
  replyTo: ActorRef<SCRReply>
  llmRef: ActorRef<LlmProviderMsg> | null
  request: MessageRequest
  persistenceRef?: ActorRef<PersistenceMsg> | null
  loop: LoopState
  tools?: ToolCollection
  model?: string
  maxToolLoops?: number
  systemPrompt?: string
  spawnerRef?: ActorRef<any>
  awaitingCostEvents?: Array<{ promptTokens: number; completionTokens: number }>
}

export const scrCompleteHelperActor = (): ActorDef<any, null> => ({
  initialState: null,
  handler: onMessage({
    invoke: (state, msg, ctx) => {
      let text = ''
      try {
        const args = typeof msg.arguments === 'string' ? JSON.parse(msg.arguments) : msg.arguments
        text = args.text || ''
      } catch (e) {
        text = msg.arguments || ''
      }

      msg.replyTo.send({
        type: 'toolResult',
        result: { text }
      })

      return { state }
    }
  })
})

export const SCRAgentRunner = (opts: {
  runId: string
  urn: string
  input: any
  replyTo: ActorRef<SCRReply>
  llmRef: ActorRef<LlmProviderMsg> | null
  request: MessageRequest
  spawnerRef?: ActorRef<any>
}): ActorDef<SCRAgentRunnerMsg, SCRAgentRunnerState> => {
  const logPrefix = `agent-runner-${opts.runId}`

  const loop = agentLoop<SCRAgentRunnerState, SCRAgentRunnerMsg>({
    role: 'reasoning',
    spanName: 'agent-runner',
    logPrefix,
    model: (state) => state.model || 'deepseek/deepseek-v4-flash',
    maxToolLoops: (state) => state.maxToolLoops ?? 25,
    llmRef: (state) => state.llmRef,
    tools: (state) => state.tools || {},

    onComplete: (state, finalText, usage, ctx) => {
      const streamTo = state.request.streamTo
      if (streamTo) {
        ctx.publish(createTopic<StreamChunk>(streamTo), {
          runId: state.runId,
          spanId: ctx.request.spanId || '',
          parentSpanId: ctx.request.parentSpanId,
          type: 'end',
        })
      }

      state.replyTo.send({
        type: 'result',
        output: state.tools && 'scr_complete' in state.tools ? { text: finalText } : undefined,
      })

      if (state.persistenceRef) {
        state.persistenceRef.send({
          type: 'kv.delete',
          key: `scr.run.${state.runId}`,
        })
      }

      ctx.stop(ctx.self)
      return { state }
    },

    onError: (state, err, ctx) => {
      const streamTo = state.request.streamTo
      if (streamTo) {
        ctx.publish(createTopic<StreamChunk>(streamTo), {
          runId: state.runId,
          spanId: ctx.request.spanId || '',
          parentSpanId: ctx.request.parentSpanId,
          type: 'error',
          error: String(err),
        })
      }

      state.replyTo.send({
        type: 'error',
        error: String(err),
      })

      if (state.persistenceRef) {
        state.persistenceRef.send({
          type: 'kv.delete',
          key: `scr.run.${state.runId}`,
        })
      }

      ctx.stop(ctx.self)
      return { state }
    },

    onStream: (state, chunk, ctx) => {
      const streamTo = state.request.streamTo
      if (streamTo) {
        ctx.publish(createTopic<StreamChunk>(streamTo), {
          runId: state.runId,
          spanId: state.loop.turn.llmSpan?.spanId || ctx.request.spanId || '',
          parentSpanId: state.loop.turn.requestSpan?.spanId || ctx.request.parentSpanId,
          type: 'chunk',
          chunk: {
            kind: chunk.kind,
            text: chunk.text,
          },
        })
      }
      return { state }
    },

    onToolPending: (state, pending, ctx) => {
      if (state.spawnerRef) {
        state.spawnerRef.send({
          type: 'registerJob',
          jobId: pending.jobId,
          runId: state.runId,
          urn: state.urn,
          toolCallId: pending.toolCallId,
          toolName: pending.toolName,
        })
      }

      state.replyTo.send({
        type: 'pending',
        jobId: pending.jobId,
        placeholderText: pending.placeholderText,
      })

      ctx.stop(ctx.self)
      return { state }
    },
  })

  const runnerInterceptor: Interceptor<SCRAgentRunnerMsg, SCRAgentRunnerState> = (state, msg, ctx, next) => {
    const request = state.request || ctx.request
    return requestStorage.run(request, () => {
      if (msg.type === 'llmToolCalls' || msg.type === 'llmDone') {
        const usage = msg.usage
        if (usage) {
          if (!state.awaitingCostEvents) {
            state.awaitingCostEvents = []
          }
          state.awaitingCostEvents.push({
            promptTokens: usage.promptTokens,
            completionTokens: usage.completionTokens,
          })
        }
      }

      if (msg.type === '_costUpdate') {
        const { event } = msg
        const userId = state.request.userId || 'system'
        if (event.userId === userId && event.role === 'reasoning') {
          const index = state.awaitingCostEvents?.findIndex(
            (item) =>
              item.promptTokens === event.inputTokens &&
              item.completionTokens === event.outputTokens
          ) ?? -1
          if (index !== -1) {
            state.awaitingCostEvents?.splice(index, 1)
            ctx.publish(UsageUpdateTopic, {
              userId,
              tokens: event.inputTokens + event.outputTokens,
              costUsd: event.cost ?? 0,
              traceId: ctx.request.traceId,
            })
          }
        }
        return { state }
      }

      if (msg.type === '_persistenceProvider') {
        return {
          state: { ...state, persistenceRef: msg.ref }
        }
      }

      if (msg.type === '_llmProvider') {
        return {
          state: { ...state, llmRef: msg.ref }
        }
      }

      if (msg.type === '_toolResult' && msg.toolName === 'scr_complete') {
        let text = ''
        if (msg.reply && msg.reply.type === 'toolResult') {
          text = msg.reply.result.text
        }

        const streamTo = state.request.streamTo
        if (streamTo) {
          ctx.publish(createTopic<StreamChunk>(streamTo), {
            runId: state.runId,
            spanId: ctx.request.spanId || '',
            parentSpanId: ctx.request.parentSpanId,
            type: 'end',
          })
        }

        state.replyTo.send({
          type: 'result',
          output: { text },
        })

        if (state.persistenceRef) {
          state.persistenceRef.send({
            type: 'kv.delete',
            key: `scr.run.${state.runId}`,
          })
        }

        ctx.stop(ctx.self)
        return {
          state: {
            ...state,
            loop: idleLoopState(),
          },
          become: loop.idle,
        }
      }

      if (msg.type === 'start') {
        const descriptor = ResolutionCache.getDescriptor(state.urn)
        if (!descriptor) {
          state.replyTo.send({
            type: 'error',
            error: `Capability descriptor not found for URN: ${state.urn}`,
          })
          ctx.stop(ctx.self)
          return { state }
        }

        const agentDescriptor = descriptor.meta?.agentDescriptor
        if (!agentDescriptor) {
          state.replyTo.send({
            type: 'error',
            error: `Agent descriptor meta not found for URN: ${state.urn}`,
          })
          ctx.stop(ctx.self)
          return { state }
        }

        const permissionContext = state.request.permission ?? { grants: ['*'] }
        const tools: ToolCollection = {}

        if (agentDescriptor.internalTools) {
          for (const t of agentDescriptor.internalTools) {
            if (authorize(permissionContext, t.name)) {
              tools[t.name] = t
            }
          }
        }

        // Pre-load agent SCR capabilities dynamically on startup
        const preloadSCRs = agentDescriptor.agentSCRs || []
        for (const metaUrn of preloadSCRs) {
          const desc = ResolutionCache.getDescriptor(metaUrn)
          if (desc && desc.target && authorize(permissionContext, metaUrn)) {
            const cleanName = desc.meta?.schema?.function?.name || metaUrn.split(':').pop()?.replace(/\./g, '_') || ''
            tools[cleanName] = {
              name: cleanName,
              schema: desc.meta?.schema || {
                type: 'function',
                function: {
                  name: cleanName,
                  description: desc.description || '',
                  parameters: desc.schema?.inputSchema || {},
                }
              },
              ref: desc.target,
            }
          }
        }

        const outputSchema = descriptor.schema?.outputSchema
        if (outputSchema) {
          const completeRef = ctx.spawn('scr-complete-helper', scrCompleteHelperActor())
          tools['scr_complete'] = {
            name: 'scr_complete',
            schema: {
              type: 'function',
              function: {
                name: 'scr_complete',
                description: 'Signal that the agent has finished its work and return the final output conforming to the schema.',
                parameters: outputSchema as any,
              },
            },
            ref: completeRef,
          }
        }

        state.tools = tools
        state.model = agentDescriptor.model
        state.maxToolLoops = agentDescriptor.maxToolLoops ?? 25
        state.systemPrompt = agentDescriptor.systemPrompt

        let promptText = ''
        if (typeof state.input === 'object' && state.input !== null && 'prompt' in state.input) {
          promptText = String((state.input as any).prompt)
        } else if (typeof state.input === 'string') {
          promptText = state.input
        }

        const streamTo = state.request.streamTo
        if (streamTo) {
          ctx.publish(createTopic<StreamChunk>(streamTo), {
            runId: state.runId,
            spanId: ctx.request.spanId || '',
            parentSpanId: ctx.request.parentSpanId,
            type: 'start',
          })
        }

        const timeContext = getUserTimeContext(state.request.timezone ?? undefined)
        const identityNote = [
          `Active User: ${state.request.userId || 'system'}`,
          `User Timezone: ${timeContext.timezone} (Offset: UTC${timeContext.offset})`,
          `Current Time: ${timeContext.dayOfWeek}, ${timeContext.formatted} (ISO: ${timeContext.iso})`
        ].join('\n')
        const fullPrompt = [agentDescriptor.systemPrompt, identityNote].filter(Boolean).join('\n\n---\n\n')

        const messages: ApiMessage[] = [
          { role: 'system', content: fullPrompt },
          { role: 'user', content: promptText },
        ]

        return loop.startTurn(state, { messages }, ctx)
      }

      return next(state, msg)
    })
  }

  return {
    initialState: () => ({
      runId: opts.runId,
      urn: opts.urn,
      input: opts.input,
      replyTo: opts.replyTo,
      llmRef: opts.llmRef,
      request: opts.request,
      spawnerRef: opts.spawnerRef,
      loop: idleLoopState(),
    }),

    persistence: persistencePluginAdapter<SCRAgentRunnerState>(`scr.run.${opts.runId}`),

    lifecycle: onLifecycle({
      start: (state, ctx) => {
        ctx.subscribe(PersistenceProviderTopic, (event) => ({
          type: '_persistenceProvider' as const,
          ref: event.ref,
        }))

        ctx.subscribe(LlmProviderTopic, (event) => ({
          type: '_llmProvider' as const,
          ref: event.ref,
        }))

        ctx.subscribe(CostTopic, (event) => ({
          type: '_costUpdate' as const,
          event,
        }))

        if (state.loop.phase === 'idle') {
          ctx.send(ctx.self, { type: 'start' }, state.request)
        }
        return { state }
      },
    }),

    handler: loop.idle,
    interceptors: [runnerInterceptor],
  }
}
