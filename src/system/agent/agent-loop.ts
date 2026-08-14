import type {
  ActorRef,
  ActorResult,
  ActorContext,
  MessageHandler,
  SpanHandle,
  EventTopic,
  Interceptor,
} from '../actor/types.ts'
import { onMessage } from '../actor/match.ts'
import { invokeSCR } from '../scr/invoker.ts'
import { ResolutionCache } from '../scr/cache.ts'
import { requestStorage } from '../context/request.ts'
import { ask } from '../actor/ask.ts'
import type { SCRReply, SCRInvokeMsg } from '../../types/scr.ts'
import type {
  ApiMessage,
  LlmProviderMsg,
  LlmProviderReply,
  TokenUsage,
  LlmTool,
  ToolCall,
} from '../../types/llm.ts'
import type { MessageAttachment } from '../../types/events.ts'

// ─── Shared turn-slice shapes ───────────────────────────────────────────────

export type LoopPendingBatch = {
  pending: Set<string>
  results: Map<string, { toolCallId: string; toolName: string; content: string }>
  spans: Map<string, SpanHandle>
  calls: Array<{ id: string; name: string; arguments: string }>
}

export type LoopTurn = {
  requestId: string | null
  turnMessages: ApiMessage[] | null
  pending: string
  pendingBatch: LoopPendingBatch | null
  toolLoopCount: number
  requestSpan: SpanHandle | null
  llmSpan: SpanHandle | null
  /** Aggregated usage across this turn (chunks + done + toolCalls). Reset on materialize. */
  pendingUsage: TokenUsage
}

const initialLoopTurn = (): LoopTurn => ({
  requestId: null,
  turnMessages: null,
  pending: '',
  pendingBatch: null,
  toolLoopCount: 0,
  requestSpan: null,
  llmSpan: null,
  pendingUsage: { promptTokens: 0, completionTokens: 0 },
})

const formatSCRResultContent = (output: unknown): string => {
  if (output === null || output === undefined) return ''
  if (typeof output === 'string') return output
  if (typeof output === 'object') {
    const obj = output as Record<string, unknown>
    if ('text' in obj && typeof obj.text === 'string') {
      const hasAttachments = Array.isArray(obj.attachments) && obj.attachments.length > 0
      const hasSources = Array.isArray(obj.sources) && obj.sources.length > 0
      if (!hasAttachments && !hasSources) {
        return obj.text
      }
      return [
        obj.text,
        'Tool result metadata:',
        JSON.stringify({
          ...(hasAttachments ? { attachments: obj.attachments } : {}),
          ...(hasSources ? { sources: obj.sources } : {}),
        }, null, 2),
      ].join('\n')
    }
    return JSON.stringify(output)
  }
  return String(output)
}

// ─── Explicit loop state ────────────────────────────────────────────────────

export type LoopState = {
  phase: 'idle' | 'awaitingLlm' | 'toolLoop'
  turn: LoopTurn
}

export const idleLoopState = (): LoopState => ({
  phase: 'idle',
  turn: initialLoopTurn(),
})

export type WithLoopState = { loop: LoopState }

// ─── Base message variants the closure dispatches on ───────────────────────

export type LoopStartTurnParams = {
  messages: ApiMessage[]
  requestSpan?: SpanHandle | null
}

export type LoopToolResultMsg = {
  type: '_toolResult'
  toolName: string
  toolCallId: string
  reply: SCRReply
}

export type LoopBaseMsg = LlmProviderReply | LoopToolResultMsg

export type LoopMsg<Extra extends { type: string } = never> = LoopBaseMsg | Extra

// ─── Error type ─────────────────────────────────────────────────────────────

export type LoopError =
  | { kind: 'llm'; error: unknown }
  | { kind: 'loopLimit'; limit: number; finalText: string }

// ─── Stream chunk ───────────────────────────────────────────────────────────

export type StreamChunk =
  | { kind: 'text'; text: string }
  | { kind: 'reasoning'; text: string }

// ─── Tool Definitions ───────────────────────────────────────────────────────

export type AgentLoopTool = {
  name: string
  urn?: string
  schema: LlmTool | { type: string; function: { name: string; description?: string; parameters?: any } }
  target?: ActorRef<any>
  ref?: ActorRef<any>
}

export type AgentLoopTools = Record<string, AgentLoopTool | any>

// ─── Hook surface ───────────────────────────────────────────────────────────

export type AgentLoopHooks<S extends WithLoopState, M extends { type: string }> = {
  role: string
  spanName: string
  logPrefix?: string

  tools: AgentLoopTools | ((s: S) => AgentLoopTools)
  model: string | ((s: S) => string)
  maxToolLoops: number | ((s: S) => number)

  llmRef: (s: S) => ActorRef<LlmProviderMsg> | null

  // When set, engine auto-emits standard UI payloads to this topic
  uiEvents?: EventTopic<{ userId: string; text: string }>

  // Static overrides for auto-emitted error text
  errorMessages?: { llm?: string; loopLimit?: string }

  onComplete: (s: S, finalText: string, usage: TokenUsage, ctx: ActorContext<M>) => { state: S }
  onError: (s: S, err: LoopError, ctx: ActorContext<M>) => { state: S }

  onStream?: (s: S, chunk: StreamChunk, ctx: ActorContext<M>) => { state: S }

  onToolResult?: (
    s: S,
    result: { toolName: string; toolCallId: string; reply: SCRReply },
    ctx: ActorContext<M>,
  ) => { state: S }

  onToolPending?: (
    s: S,
    result: { toolName: string; toolCallId: string; jobId: string; placeholderText?: string },
    ctx: ActorContext<M>,
  ) => { state: S }

  onBatchHistoryReady?: (
    s: S,
    messages: ApiMessage[],
    ctx: ActorContext<M>,
  ) => { state: S }
}

// ─── Exported handle ────────────────────────────────────────────────────────

export type AgentLoopHandle<M extends { type: string }, S extends WithLoopState> = {
  idle: MessageHandler<M, S>
  startTurn: (state: S, params: LoopStartTurnParams, ctx: ActorContext<M>) => ActorResult<M, S>
  cancelTurn: (state: S, ctx: ActorContext<M>) => ActorResult<M, S>
}

// ─── Internal engine ────────────────────────────────────────────────────────

const resolveToolUrn = (name: string, toolDef?: { name?: string; urn?: string; schema?: any }): string => {
  if (toolDef?.urn) return toolDef.urn
  if (name.startsWith('scr:')) return name
  if (name === 'scr_complete') return 'scr:leaf:agent.complete'

  // Try direct URN lookup in ResolutionCache
  const directDesc = ResolutionCache.getDescriptor(name)
  if (directDesc) return directDesc.urn

  // Try standard leaf prefix
  const dotName = name.replace(/_/g, '.')
  const leafDotDesc = ResolutionCache.getDescriptor(`scr:leaf:${dotName}`)
  if (leafDotDesc) return leafDotDesc.urn

  const leafDirectDesc = ResolutionCache.getDescriptor(`scr:leaf:${name}`)
  if (leafDirectDesc) return leafDirectDesc.urn

  // Search by meta schema name or suffix
  const all = ResolutionCache.getAllDescriptors()
  for (const desc of all) {
    if (desc.meta?.schema?.function?.name === name || desc.urn.endsWith(`.${name}`) || desc.urn.endsWith(`:${name}`)) {
      return desc.urn
    }
  }

  // Fallback to standard leaf urn format
  return `scr:leaf:${dotName}`
}

const createLoopEngine = <S extends WithLoopState, M extends { type: string }>(hooks: AgentLoopHooks<S, M>) => {
  const log = hooks.logPrefix ?? hooks.spanName
  const { tools: toolsCfg } = hooks

  const resolveModel = (s: S): string =>
    typeof hooks.model === 'function' ? hooks.model(s) : hooks.model

  const resolveMaxToolLoops = (s: S): number =>
    typeof hooks.maxToolLoops === 'function' ? hooks.maxToolLoops(s) : hooks.maxToolLoops

  const resolveTools = (s: S): AgentLoopTools =>
    typeof toolsCfg === 'function' ? toolsCfg(s) : (toolsCfg || {})

  const resolveSchemas = (s: S): LlmTool[] => {
    const rawTools = resolveTools(s)
    if (!rawTools) return []
    return Object.values(rawTools).map((e: any) => {
      if (e.schema) return e.schema as LlmTool
      if (e.function) return { type: 'function', function: e.function } as LlmTool
      return e as LlmTool
    })
  }

  const addUsage = (a: TokenUsage, b: TokenUsage | null | undefined): TokenUsage =>
    b ? { 
      promptTokens: a.promptTokens + b.promptTokens, 
      completionTokens: a.completionTokens + b.completionTokens }
    : a

  const materialize = (state: S): ActorResult<M, S> => ({
    state: { ...state, loop: idleLoopState() } as S,
    become: idle,
    unstashAll: true,
  })

  const emitUi = (payload: unknown, ctx: ActorContext<M>) => {
    const targetUserId = ctx.request.userId
    if (hooks.uiEvents && targetUserId) {
      ctx.publish(hooks.uiEvents, { userId: targetUserId, text: JSON.stringify(payload) })
    }
  }

  // ── Helper: send `stream` to LLM and return the new llmSpan ──────────────
  const sendStream = (
    state: S,
    requestId: string,
    messages: ApiMessage[],
    requestSpan: SpanHandle | null,
    ctx: ActorContext<M>,
  ): SpanHandle | null => {
    const model = resolveModel(state)
    const llmSpan = requestSpan
      ? ctx.trace.child(requestSpan.traceId, requestSpan.spanId, 'llm-call', { model })
      : ctx.trace.span('llm-call', { model })
    const schemas = resolveSchemas(state)
    const llmRef = hooks.llmRef(state)
    if (!llmRef) throw new Error(`${log}: llmRef is null`)
    ctx.send(llmRef, {
      type: 'stream',
      requestId,
      model,
      messages,
      tools: schemas.length > 0 ? schemas : undefined,
      role: hooks.role,
      replyTo: ctx.self as unknown as ActorRef<LlmProviderReply>,
    })
    return llmSpan
  }

  // ── startTurn: in-process entry, shared by all agents ────────────────────
  const startTurn = (state: S, params: LoopStartTurnParams, ctx: ActorContext<M>): ActorResult<M, S> => {
    const llmRef = hooks.llmRef(state)
    if (!llmRef) {
      ctx.log.warn(`${log}: not ready (no LLM provider)`)
      return { state }
    }

    emitUi({ type: 'start' }, ctx)

    let requestSpan: SpanHandle | null = params.requestSpan ?? null
    if (!requestSpan) {
      if (ctx.request.traceId && ctx.request.spanId) {
        requestSpan = ctx.trace.child(ctx.request.traceId, ctx.request.spanId, hooks.spanName, {})
      } else {
        requestSpan = ctx.trace.span(hooks.spanName)
      }
    }

    const requestId = crypto.randomUUID()
    const turn: LoopTurn = {
      ...initialLoopTurn(),
      requestId,
      turnMessages: params.messages,
      requestSpan,
    }
    const llmSpan = sendStream(state, requestId, params.messages, requestSpan, ctx)

    return {
      state: { ...state, loop: { phase: 'awaitingLlm', turn: { ...turn, llmSpan } } } as S,
      become: awaitingLlm,
    }
  }

  const cancelTurn = (state: S, ctx: ActorContext<M>): ActorResult<M, S> => {
    const turn = state.loop.turn
    if (state.loop.phase === 'idle') {
      return { state }
    }

    if (turn.llmSpan) turn.llmSpan.error('cancelled')
    if (turn.requestSpan) turn.requestSpan.error('cancelled')
    if (turn.pendingBatch?.spans) {
      for (const span of turn.pendingBatch.spans.values()) {
        span.error('cancelled')
      }
    }

    ctx.log.info(`${log}: loop cancelled by user`)

    emitUi({ type: 'done' }, ctx)

    return materialize(state)
  }

  // ── Idle handler ─────────────────────────────────────────────────────────
  const idle: MessageHandler<M, S> = (_state, _msg, _ctx) => {
    return { state: _state }
  }

  // ── Awaiting LLM handler ─────────────────────────────────────────────────
  const awaitingLlm: MessageHandler<M, S> = onMessage<any, S>({
    llmChunk: (state, msg, ctx: ActorContext<M>) => {
      const chunk = msg as Extract<LlmProviderReply, { type: 'llmChunk' }>
      const turn = state.loop.turn
      if (chunk.requestId !== turn.requestId) return { state }
      const nextTurn: LoopTurn = { ...turn, pending: turn.pending + chunk.text }
      let nextState = { ...state, loop: { ...state.loop, turn: nextTurn } } as S
      if (hooks.onStream) {
        const r = hooks.onStream(nextState, { kind: 'text', text: chunk.text }, ctx)
        nextState = r.state
      }
      emitUi({ type: 'chunk', text: chunk.text }, ctx)
      return { state: nextState }
    },

    llmReasoningChunk: (state, msg, ctx: ActorContext<M>) => {
      const chunk = msg as Extract<LlmProviderReply, { type: 'llmReasoningChunk' }>
      const turn = state.loop.turn
      if (chunk.requestId !== turn.requestId) return { state }
      if (!hooks.onStream) {
        emitUi({ type: 'reasoningChunk', text: chunk.text }, ctx)
        return { state }
      }
      const r = hooks.onStream(state, { kind: 'reasoning', text: chunk.text }, ctx)
      emitUi({ type: 'reasoningChunk', text: chunk.text }, ctx)
      return { state: r.state }
    },

    llmToolCalls: (state, msg, ctx: ActorContext<M>) => {
      const tc = msg as Extract<LlmProviderReply, { type: 'llmToolCalls' }>
      const turn = state.loop.turn
      if (tc.requestId !== turn.requestId) return { state }

      turn.llmSpan?.done({ toolCalls: tc.calls.map(c => c.name) })
      ctx.log.info(`${log}: tool calls`, { tools: tc.calls.map(c => c.name) })

      const accumulatedUsage = addUsage(turn.pendingUsage, tc.usage)
      emitUi({ type: 'tooling', tools: tc.calls.map(c => ({ name: c.name, arguments: c.arguments })) }, ctx)

      const tools = resolveTools(state)
      const knownCalls: typeof tc.calls = []
      const skippedUnknownCalls: typeof tc.calls = []
      for (const call of tc.calls) {
        if (tools[call.name] || call.name === 'scr_complete' || ResolutionCache.getDescriptor(resolveToolUrn(call.name, tools[call.name]))) {
          knownCalls.push(call)
          continue
        }
        ctx.log.warn(`${log}: unknown tool (skipped)`, { tool: call.name })
        skippedUnknownCalls.push(call)
      }

      const spans = new Map<string, SpanHandle>()
      for (const call of knownCalls) {
        if (turn.requestSpan) {
          spans.set(call.id, ctx.trace.child(
            turn.requestSpan.traceId,
            turn.requestSpan.spanId,
            'tool-invoke',
            { toolName: call.name, arguments: call.arguments },
          ))
        } else {
          spans.set(call.id, ctx.trace.span(
            'tool-invoke',
            { toolName: call.name, arguments: call.arguments },
          ))
        }
      }

      const batch: LoopPendingBatch = {
        pending: new Set([...knownCalls.map(c => c.id), ...skippedUnknownCalls.map(c => c.id)]),
        results: new Map(),
        spans,
        calls: tc.calls,
      }

      const userId = ctx.request.userId
      const permission = ctx.request.permission || { grants: ['*'] }

      for (const call of knownCalls) {
        const toolDef = tools[call.name]
        const urn = resolveToolUrn(call.name, toolDef)
        let parsedInput: unknown
        try {
          parsedInput = typeof call.arguments === 'string' && call.arguments.trim().length > 0
            ? JSON.parse(call.arguments)
            : (call.arguments || {})
        } catch {
          parsedInput = call.arguments
        }

        // Special handling for scr_complete pseudo tool
        if (call.name === 'scr_complete') {
          const synthetic: M = {
            type: '_toolResult',
            toolName: call.name,
            toolCallId: call.id,
            reply: { type: 'result', output: parsedInput },
          } as unknown as M
          ctx.send(ctx.self, synthetic)
          continue
        }

        const toolSpan = spans.get(call.id)
        const subRequest = {
          ...ctx.request,
          userId,
          permission,
          traceId: toolSpan?.traceId ?? ctx.request.traceId,
          spanId: toolSpan?.spanId ?? ctx.request.spanId,
        }

        const targetRef = (toolDef as any)?.target || (toolDef as any)?.ref

        const invocationPromise = targetRef
          ? ask<any, any>(
              targetRef,
              (replyTo) => ({
                type: 'invoke',
                urn,
                toolName: call.name,
                arguments: typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments),
                input: parsedInput,
                replyTo,
              }),
              undefined,
              subRequest,
            ).then((rep: any): SCRReply => {
              if (rep.type === 'toolResult') {
                return { type: 'result', output: rep.result }
              }
              if (rep.type === 'toolError') {
                return { type: 'error', error: rep.error }
              }
              if (rep.type === 'toolPending') {
                return { type: 'pending', jobId: rep.jobId, placeholderText: rep.placeholderText }
              }
              return rep as SCRReply
            })
          : requestStorage.run(subRequest, () => invokeSCR(urn, parsedInput))

        ctx.pipeToSelf(
          invocationPromise,
          (reply) => ({
            type: '_toolResult',
            toolName: call.name,
            toolCallId: call.id,
            reply,
          } as unknown as M),
          (error) => ({
            type: '_toolResult',
            toolName: call.name,
            toolCallId: call.id,
            reply: { type: 'error', error: String(error) },
          } as unknown as M),
        )
      }

      for (const call of skippedUnknownCalls) {
        const synthetic: M = {
          type: '_toolResult',
          toolName: call.name,
          toolCallId: call.id,
          reply: { type: 'error', error: `Tool not available: ${call.name}` },
        } as unknown as M
        ctx.send(ctx.self, synthetic)
      }

      const nextState = {
        ...state,
        loop: {
          phase: 'toolLoop' as const,
          turn: { ...turn, requestId: null, llmSpan: null, pendingBatch: batch, pendingUsage: accumulatedUsage },
        },
      } as S

      return { state: nextState, become: toolLoop }
    },

    llmDone: (state, msg, ctx: ActorContext<M>) => {
      const done = msg as Extract<LlmProviderReply, { type: 'llmDone' }>
      const turn = state.loop.turn
      if (done.requestId !== turn.requestId) return { state }
      turn.llmSpan?.done()
      turn.requestSpan?.done()
      ctx.log.info(`${log}: done`, { chars: turn.pending.length })
      const usage = addUsage(turn.pendingUsage, done.usage)
      const nextState = { ...state, loop: { ...state.loop, turn: { ...turn, pendingUsage: usage } } } as S
      const r = hooks.onComplete(nextState, turn.pending, usage, ctx)
      emitUi({ type: 'done' }, ctx)
      return materialize(r.state)
    },

    llmError: (state, msg, ctx: ActorContext<M>) => {
      const err = msg as Extract<LlmProviderReply, { type: 'llmError' }>
      const turn = state.loop.turn
      if (err.requestId !== turn.requestId) return { state }
      turn.llmSpan?.error(err.error)
      turn.requestSpan?.error(err.error)
      ctx.log.error(`${log}: LLM error`, { error: String(err.error) })
      const r = hooks.onError(state, { kind: 'llm', error: err.error }, ctx)
      emitUi({ type: 'error', text: hooks.errorMessages?.llm ?? 'Something went wrong. Please try again.' }, ctx)
      return materialize(r.state)
    },
  })

  // ── Tool loop handler ────────────────────────────────────────────────────
  const toolLoop: MessageHandler<M, S> = onMessage<any, S>({
    _toolResult: (state, msg, ctx: ActorContext<M>) => {
      const m = msg as LoopToolResultMsg
      const turn = state.loop.turn
      const batch = turn.pendingBatch!
      const span = batch.spans.get(m.toolCallId)

      if (m.reply.type === 'pending') {
        const pendingText = m.reply.placeholderText ?? `Background job started for ${m.toolName} (jobId=${m.reply.jobId}).`
        span?.done({ jobId: m.reply.jobId, pending: true })
        turn.requestSpan?.done({ pendingJobId: m.reply.jobId, toolName: m.toolName })
        ctx.log.info(`${log}: tool pending`, { tool: m.toolName, jobId: m.reply.jobId })
        emitUi({ type: 'chunk', text: pendingText }, ctx)
        emitUi({ type: 'done' }, ctx)
        const r = hooks.onToolPending
          ? hooks.onToolPending(state, {
            toolName: m.toolName,
            toolCallId: m.toolCallId,
            jobId: m.reply.jobId,
            placeholderText: m.reply.placeholderText,
          }, ctx)
          : { state }
        return materialize(r.state)
      }

      if (m.reply.type === 'result' && m.reply.output === undefined) {
        span?.done()
        ctx.log.info(`${log}: tool result undefined (loop terminated)`, { tool: m.toolName })
        
        let withResultState = state
        if (hooks.onToolResult) {
          const r = hooks.onToolResult(state, { toolName: m.toolName, toolCallId: m.toolCallId, reply: m.reply }, ctx)
          withResultState = r.state
        }

        const r = hooks.onComplete
          ? hooks.onComplete(withResultState, turn.pending, { promptTokens: 0, completionTokens: 0 }, ctx)
          : { state: withResultState }
        
        const finalState = {
          ...r.state,
          loop: idleLoopState(),
        } as S
        
        emitUi({ type: 'done' }, ctx)
        return { state: finalState, become: idle }
      }

      if (m.reply.type === 'result') {
        span?.done()
        ctx.log.info(`${log}: tool result`, { tool: m.toolName, ok: true })
      } else {
        span?.error(m.reply.error)
        ctx.log.warn(`${log}: tool error`, { tool: m.toolName, error: m.reply.error })
      }

      const content = m.reply.type === 'result'
        ? formatSCRResultContent(m.reply.output)
        : `Tool error: ${m.reply.error}`

      batch.results.set(m.toolCallId, { toolCallId: m.toolCallId, toolName: m.toolName, content })
      batch.pending.delete(m.toolCallId)

      let withResultState = state
      if (hooks.onToolResult) {
        const r = hooks.onToolResult(state, { toolName: m.toolName, toolCallId: m.toolCallId, reply: m.reply }, ctx)
        withResultState = r.state
      }

      // Dynamic discovery binding: if tool returned descriptors (e.g. from registry_search)
      if (m.reply.type === 'result' && m.reply.output) {
        try {
          let descriptors: any[] = []
          const out = m.reply.output
          if (Array.isArray(out)) {
            descriptors = out
          } else if (typeof out === 'object' && out !== null && 'descriptors' in out && Array.isArray((out as any).descriptors)) {
            descriptors = (out as any).descriptors
          } else if (typeof out === 'string') {
            const parsed = JSON.parse(out)
            descriptors = Array.isArray(parsed) ? parsed : (parsed?.descriptors || [parsed])
          }
          for (const desc of descriptors) {
            if (desc && typeof desc === 'object' && desc.urn) {
              const cleanName = desc.meta?.schema?.function?.name || desc.urn.split(':').pop()?.replace(/[\.:]/g, '_') || desc.urn
              const stateAny = withResultState as any
              if (!stateAny.tools) {
                stateAny.tools = {}
              }
              if (!(cleanName in stateAny.tools)) {
                stateAny.tools[cleanName] = {
                  name: cleanName,
                  urn: desc.urn,
                  schema: desc.meta?.schema || {
                    type: 'function',
                    function: {
                      name: cleanName,
                      description: desc.description || '',
                      parameters: desc.schema?.inputSchema || {},
                    }
                  },
                }
                ctx.log.info(`${log}: dynamically bound tool schema mid-flight: ${cleanName} (${desc.urn})`)
              }
            }
          }
        } catch {
          // ignore parsing error
        }
      }

      // Auto-emit sources/attachments
      if (m.reply.type === 'result' && m.reply.output && typeof m.reply.output === 'object') {
        const out = m.reply.output as Record<string, unknown>
        if (Array.isArray(out.sources) && out.sources.length > 0) {
          emitUi({ type: 'sources', sources: out.sources }, ctx)
        }
        if (Array.isArray(out.attachments) && out.attachments.length > 0) {
          emitUi({ type: 'attachments', attachments: out.attachments }, ctx)
        }
      }

      if (batch.pending.size > 0) {
        const nextState = {
          ...withResultState,
          loop: {
            ...withResultState.loop,
            turn: { ...turn, pendingBatch: { ...batch } },
          },
        } as S
        return { state: nextState }
      }

      const toolResultMsgs: ApiMessage[] = Array.from(batch.results.values()).map(r => ({
        role: 'tool', content: r.content, tool_call_id: r.toolCallId,
      }))
      const assistantToolCalls: ToolCall[] = batch.calls.map(c => ({
        id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments },
      }))
      const batchHistory: ApiMessage[] = [
        { role: 'assistant', content: null, tool_calls: assistantToolCalls },
        ...toolResultMsgs,
      ]

      let withBatchState = withResultState
      if (hooks.onBatchHistoryReady) {
        const r = hooks.onBatchHistoryReady(withResultState, batchHistory, ctx)
        withBatchState = r.state
      }

      const nextLoopCount = turn.toolLoopCount + 1
      const maxToolLoops = resolveMaxToolLoops(withBatchState)
      if (nextLoopCount >= maxToolLoops) {
        ctx.log.warn(`${log}: tool loop limit reached`, { limit: maxToolLoops })
        turn.requestSpan?.error('Tool loop limit reached')
        const r = hooks.onError(withBatchState, { kind: 'loopLimit', limit: maxToolLoops, finalText: turn.pending }, ctx)
        emitUi({ type: 'error', text: hooks.errorMessages?.loopLimit ?? 'Tool loop limit reached. Please try again.' }, ctx)
        return materialize(r.state)
      }

      const nextMessages: ApiMessage[] = [
        ...(turn.turnMessages ?? []),
        ...batchHistory,
      ]

      const requestId = crypto.randomUUID()
      const nextTurn: LoopTurn = {
        ...turn,
        requestId,
        turnMessages: nextMessages,
        pending: '',
        pendingBatch: null,
        toolLoopCount: nextLoopCount,
        llmSpan: null,
      }
      const llmSpan = sendStream(withBatchState, requestId, nextMessages, turn.requestSpan, ctx)
      const nextState = {
        ...withBatchState,
        loop: {
          phase: 'awaitingLlm' as const,
          turn: { ...nextTurn, llmSpan },
        },
      } as S

      return { state: nextState, become: awaitingLlm }
    }
  })

  return {
    idle,
    startTurn,
    cancelTurn,
  }
}

export const agentLoop = <S extends WithLoopState, M extends { type: string }>(hooks: AgentLoopHooks<S, M>): AgentLoopHandle<M, S> => createLoopEngine(hooks)

// ─── Reusable interceptors ──────────────────────────────────────────────────

export const idleGuardInterceptor = <M extends { type: string }, S extends WithLoopState>(
  triggerType: string,
  handler: (state: S, msg: Extract<M, { type: typeof triggerType }>, ctx: ActorContext<M>) => ActorResult<M, S>,
): Interceptor<M, S> => (state, msg, ctx, next) => {
  const m = msg as M
  if (m.type === triggerType) {
    if (state.loop.phase !== 'idle') return { state, stash: true }
    return handler(state, m as Extract<M, { type: typeof triggerType }>, ctx)
  }
  return next(state, msg)
}
