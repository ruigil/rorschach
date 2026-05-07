import type {
  ActorRef,
  ActorResult,
  ActorContext,
  MessageHandler,
  SpanHandle,
} from './types.ts'
import { onMessage } from './match.ts'
import { invokeTool } from './invoke-tool.ts'
import type {
  ToolCollection,
  ToolEntry,
  ToolFinalReply,
  ToolReply,
} from '../types/tools.ts'
import type {
  ApiMessage,
  LlmProviderMsg,
  LlmProviderReply,
  Tool,
  ToolCall,
} from '../types/llm.ts'

// ─── Shared turn-slice shapes ───────────────────────────────────────────────

export type ReactPendingBatch = {
  remaining:          number
  results:            { toolCallId: string; toolName: string; content: string }[]
  messagesAtCall:     ApiMessage[]
  assistantToolCalls: ToolCall[]
  spans:              Record<string, SpanHandle>
}

export type ReactTurn = {
  requestId:     string | null
  turnMessages:  ApiMessage[] | null
  pending:       string
  pendingBatch:  ReactPendingBatch | null
  toolLoopCount: number
  requestSpan:   SpanHandle | null
  llmSpan:       SpanHandle | null
  userId:        string
  clientId:      string | undefined
  replyTo:       ActorRef<ToolReply> | null
}

export const initialReactTurn = (): ReactTurn => ({
  requestId:     null,
  turnMessages:  null,
  pending:       '',
  pendingBatch:  null,
  toolLoopCount: 0,
  requestSpan:   null,
  llmSpan:       null,
  userId:        '',
  clientId:      undefined,
  replyTo:       null,
})

/** Loop-internal mutable state. Agents hold this in one field of their state bag. */
export type ReactLoopSlice = {
  llmRef: ActorRef<LlmProviderMsg> | null
  turn:   ReactTurn
}

export const initialReactLoopSlice = (): ReactLoopSlice => ({
  llmRef: null,
  turn:   initialReactTurn(),
})

// ─── Base message variants the closure dispatches on ───────────────────────

export type ReactInvokeMsg = {
  type:      'invoke'
  toolName:  string
  arguments: string
  clientId?: string
  userId:    string
  replyTo:   ActorRef<ToolReply>
}

export type ReactToolResultMsg = {
  type:       '_toolResult'
  toolName:   string
  toolCallId: string
  reply:      ToolFinalReply
}

export type ReactSubscriptionMsg =
  | { type: '_llmProvider'; ref: ActorRef<LlmProviderMsg> | null }

/**
 * Reference shape of variants the closure dispatches on. Agents must include
 * each of these in their own message union (with matching field shapes), and
 * may add additional variants on top — the closure ignores anything it
 * doesn't recognise.
 */
export type ReactBaseMsg =
  | ReactInvokeMsg
  | LlmProviderReply
  | ReactToolResultMsg
  | ReactSubscriptionMsg

// ─── Hook surface ──────────────────────────────────────────────────────────

export type ReactCompletionAction<S> = { state: S; unstashAll?: boolean }

/** Result of buildTurn: either reject with error, or accept with the turn's initial messages. */
export type ReactBuildTurnResult =
  | { error: string }
  | { messages: ApiMessage[] }

export type ReactSpanPolicy = 'fromHeaders' | 'always' | 'never'

export type ReactLoopHooks<S, M extends { type: string }> = {
  /** Role string sent on every LLM stream message (e.g. 'google', 'memory-recall'). */
  role:         string
  /** Operation name used when creating the per-request root span. */
  spanName:     string
  /** Prefix used in info/warn/error log messages. Defaults to `spanName`. */
  logPrefix?:   string

  // ─── Per-actor config (immutable for the lifetime of the actor) ───
  tools:        ToolCollection
  model:        string
  maxToolLoops: number

  // ─── Loop state slice ───
  slice:        (s: S) => ReactLoopSlice
  setSlice:     (s: S, slice: ReactLoopSlice) => S

  // ─── Entry ───
  /** Validate the invoke message and produce the turn's initial messages. */
  buildTurn:     (s: S, msg: ReactInvokeMsg, ctx: ActorContext<M>) => ReactBuildTurnResult

  // ─── Completion handlers ───
  /** Called on `llmDone` after the request span is closed. Returned state is applied and the actor becomes idle. */
  onComplete:    (s: S, finalText: string, ctx: ActorContext<M>) => ReactCompletionAction<S>
  /** Called on `llmError`. Spans are already closed by the closure. */
  onLlmError:    (s: S, error: unknown,  ctx: ActorContext<M>) => ReactCompletionAction<S>
  /** Called when the tool-loop ceiling is hit. The current `pending` text is passed in. */
  onLoopLimit:   (s: S, finalText: string, ctx: ActorContext<M>) => ReactCompletionAction<S>

  // ─── Optional streaming hooks ───
  onChunk?:           (s: S, chunkText: string, requestId: string, ctx: ActorContext<M>) => S
  onReasoningChunk?:  (s: S, chunkText: string, requestId: string, ctx: ActorContext<M>) => S

  // ─── Knobs ───
  /** Stash concurrent `invoke` messages while a turn is in flight. Default: true. */
  stashConcurrent?:   boolean
  /** Span policy. 'fromHeaders' — only when caller propagated headers (default). 'always' — always create a root span. 'never' — no spans. */
  spans?:             ReactSpanPolicy
}

// ─── Closure result ────────────────────────────────────────────────────────

export type ReactLoopHandlers<M extends { type: string }, S> = {
  idle:        MessageHandler<M, S>
  awaitingLlm: MessageHandler<M, S>
  toolLoop:    MessageHandler<M, S>
}

// ─── Implementation ────────────────────────────────────────────────────────

export const createReactLoop = <S, M extends { type: string }>(
  hooks: ReactLoopHooks<S, M>,
): ReactLoopHandlers<M, S> => {
  const log       = hooks.logPrefix ?? hooks.spanName
  const stash     = hooks.stashConcurrent !== false
  const spansMode = hooks.spans ?? 'fromHeaders'

  const { tools: toolsCfg, model, maxToolLoops } = hooks
  const toolSchemas = Object.values(toolsCfg).map((e: ToolEntry) => e.schema as Tool)

  // mutually-recursive handler refs
  let idle:        MessageHandler<M, S>
  let awaitingLlm: MessageHandler<M, S>
  let toolLoop:    MessageHandler<M, S>

  // ── Slice accessors ───────────────────────────────────────────────────────
  const getTurn   = (s: S): ReactTurn => hooks.slice(s).turn
  const withTurn  = (s: S, turn: ReactTurn): S => hooks.setSlice(s, { ...hooks.slice(s), turn })
  const getLlmRef = (s: S): ActorRef<LlmProviderMsg> | null => hooks.slice(s).llmRef

  const materialize = (a: ReactCompletionAction<S>): ActorResult<M, S> => {
    const reset = hooks.setSlice(a.state, { ...hooks.slice(a.state), turn: initialReactTurn() })
    return { state: reset, become: idle, unstashAll: a.unstashAll ?? true }
  }

  // ── Helper: send `stream` to LLM and return the new llmSpan ───────────────
  const sendStream = (
    state:     S,
    requestId: string,
    messages:  ApiMessage[],
    ctx:       ActorContext<M>,
  ): SpanHandle | null => {
    const turn = getTurn(state)
    const llmSpan = turn.requestSpan
      ? ctx.trace.child(turn.requestSpan.traceId, turn.requestSpan.spanId, 'llm-call', { model })
      : null
    getLlmRef(state)!.send({
      type:     'stream',
      requestId,
      model,
      messages,
      tools:    toolSchemas.length > 0 ? toolSchemas : undefined,
      role:     hooks.role,
      clientId: turn.clientId,
      replyTo:  ctx.self as unknown as ActorRef<LlmProviderReply>,
    })
    return llmSpan
  }

  // ── Subscription cases (shared across all three handlers) ─────────────────
  const subscriptionCases = {
    _llmProvider: (state: S, msg: Extract<ReactSubscriptionMsg, { type: '_llmProvider' }>) =>
      ({ state: hooks.setSlice(state, { ...hooks.slice(state), llmRef: msg.ref }) }),
  }

  // ── Helper: drive the next turn (used by toolLoop after a complete batch) ──
  const startNextTurn = (
    state:        S,
    nextMessages: ApiMessage[],
    nextLoopCount: number,
    ctx:          ActorContext<M>,
  ): ActorResult<M, S> => {
    const requestId = crypto.randomUUID()
    let next = withTurn(state, {
      ...getTurn(state),
      requestId,
      turnMessages:  nextMessages,
      pending:       '',
      pendingBatch:  null,
      toolLoopCount: nextLoopCount,
      llmSpan:       null,
    })
    const llmSpan = sendStream(next, requestId, nextMessages, ctx)
    next = withTurn(next, { ...getTurn(next), llmSpan })
    return { state: next, become: awaitingLlm }
  }

  // ── idle ─────────────────────────────────────────────────────────────────
  const idleCases: any = {
    invoke: (state: S, msg: ReactInvokeMsg, ctx: ActorContext<M>) => {
      const inv = msg

      const built = hooks.buildTurn(state, inv, ctx)
      if ('error' in built) {
        inv.replyTo.send({ type: 'toolError', error: built.error })
        return { state }
      }
      if (!getLlmRef(state)) {
        inv.replyTo.send({ type: 'toolError', error: `${log} not ready (no LLM provider).` })
        return { state }
      }

      let requestSpan: SpanHandle | null = null
      if (spansMode === 'fromHeaders') {
        const parent = ctx.trace.fromHeaders()
        requestSpan = parent
          ? ctx.trace.child(parent.traceId, parent.spanId, hooks.spanName, {})
          : null
      } else if (spansMode === 'always') {
        requestSpan = ctx.trace.start(hooks.spanName, {})
      }

      const requestId = crypto.randomUUID()
      let next = withTurn(state, {
        ...getTurn(state),
        requestId,
        turnMessages:  built.messages,
        pending:       '',
        pendingBatch:  null,
        toolLoopCount: 0,
        requestSpan,
        llmSpan:       null,
        userId:        inv.userId,
        clientId:      inv.clientId,
        replyTo:       inv.replyTo,
      })
      const llmSpan = sendStream(next, requestId, built.messages, ctx)
      next = withTurn(next, { ...getTurn(next), llmSpan })

      ctx.log.info(`${log}: request started`, { userId: inv.userId })

      return { state: next, become: awaitingLlm }
    },

    ...subscriptionCases,
  }

  idle = onMessage<M, S>(idleCases) as MessageHandler<M, S>

  // ── awaitingLlm ──────────────────────────────────────────────────────────
  const awaitingLlmCases: any = {
    llmChunk: (state: S, msg: Extract<LlmProviderReply, { type: 'llmChunk' }>, ctx: ActorContext<M>) => {
      const turn = getTurn(state)
      if (msg.requestId !== turn.requestId) return { state }
      let next = withTurn(state, { ...turn, pending: turn.pending + msg.text })
      if (hooks.onChunk) next = hooks.onChunk(next, msg.text, msg.requestId, ctx)
      return { state: next }
    },

    llmReasoningChunk: (state: S, msg: Extract<LlmProviderReply, { type: 'llmReasoningChunk' }>, ctx: ActorContext<M>) => {
      if (hooks.onReasoningChunk) {
        return { state: hooks.onReasoningChunk(state, msg.text, msg.requestId, ctx) }
      }
      return { state }
    },

    llmToolCalls: (state: S, msg: Extract<LlmProviderReply, { type: 'llmToolCalls' }>, ctx: ActorContext<M>) => {
      const turn = getTurn(state)
      if (msg.requestId !== turn.requestId) return { state }

      turn.llmSpan?.done({ toolCalls: msg.calls.map(c => c.name) })
      ctx.log.info(`${log}: tool calls`, { tools: msg.calls.map(c => c.name) })

      const tools = toolsCfg
      const assistantToolCalls: ToolCall[] = msg.calls.map(c => ({
        id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments },
      }))

      // Partition calls into known/unknown. Unknown calls generate synthetic
      // toolError feedback so the LLM sees the failure on the next turn.
      const knownCalls: typeof msg.calls = []
      const skippedUnknownCalls: typeof msg.calls = []
      for (const call of msg.calls) {
        if (tools[call.name]) {
          knownCalls.push(call)
          continue
        }
        ctx.log.warn(`${log}: unknown tool (skipped)`, { tool: call.name })
        skippedUnknownCalls.push(call)
      }

      const spans: Record<string, SpanHandle> = {}
      for (const call of knownCalls) {
        if (turn.requestSpan) {
          spans[call.id] = ctx.trace.child(
            turn.requestSpan.traceId, turn.requestSpan.spanId,
            'tool-invoke',
            { toolName: call.name, arguments: call.arguments },
          )
        }
      }

      const batch: ReactPendingBatch = {
        remaining:          knownCalls.length + skippedUnknownCalls.length,
        results:            [],
        messagesAtCall:     turn.turnMessages!,
        assistantToolCalls,
        spans,
      }

      const userId   = turn.userId
      const clientId = turn.clientId

      // Real tool invocations
      for (const call of knownCalls) {
        const entry    = tools[call.name]!
        const toolSpan = spans[call.id]
        ctx.pipeToSelf(
          invokeTool(ctx, entry.ref,
            { toolName: call.name, arguments: call.arguments, clientId, userId },
            { headers: toolSpan ? ctx.trace.injectHeaders(toolSpan) : undefined },
          ),
          (reply) => ({
            type:       '_toolResult',
            toolName:   call.name,
            toolCallId: call.id,
            reply,
          } as unknown as M),
          (error) => ({
            type:       '_toolResult',
            toolName:   call.name,
            toolCallId: call.id,
            reply:      { type: 'toolError', error: String(error) },
          } as unknown as M),
        )
      }

      // Synthetic tool-error feedback for skipped unknown calls — keeps the
      // batch counter consistent and surfaces the error to the LLM next turn.
      for (const call of skippedUnknownCalls) {
        const synthetic: M = {
          type:       '_toolResult',
          toolName:   call.name,
          toolCallId: call.id,
          reply:      { type: 'toolError', error: `Tool not available: ${call.name}` },
        } as unknown as M
        ctx.self.send(synthetic)
      }

      const next = withTurn(state, { ...turn, requestId: null, llmSpan: null, pendingBatch: batch })
      return { state: next, become: toolLoop }
    },

    llmDone: (state: S, msg: Extract<LlmProviderReply, { type: 'llmDone' }>, ctx: ActorContext<M>) => {
      const turn = getTurn(state)
      if (msg.requestId !== turn.requestId) return { state }
      turn.llmSpan?.done()
      turn.requestSpan?.done()
      ctx.log.info(`${log}: done`, { chars: turn.pending.length })
      return materialize(hooks.onComplete(state, turn.pending, ctx))
    },

    llmError: (state: S, msg: Extract<LlmProviderReply, { type: 'llmError' }>, ctx: ActorContext<M>) => {
      const turn = getTurn(state)
      if (msg.requestId !== turn.requestId) return { state }
      turn.llmSpan?.error(msg.error)
      turn.requestSpan?.error(msg.error)
      ctx.log.error(`${log}: LLM error`, { error: String(msg.error) })
      return materialize(hooks.onLlmError(state, msg.error, ctx))
    },

    ...subscriptionCases,
  }

  if (stash) {
    awaitingLlmCases.invoke = (state: S) => ({ state, stash: true })
  }

  awaitingLlm = onMessage<M, S>(awaitingLlmCases) as MessageHandler<M, S>

  // ── toolLoop ─────────────────────────────────────────────────────────────
  const toolLoopCases: any = {
    _toolResult: (state: S, msg: ReactToolResultMsg, ctx: ActorContext<M>) => {
      const turn  = getTurn(state)
      const batch = turn.pendingBatch!
      const span  = batch.spans[msg.toolCallId]
      if (msg.reply.type === 'toolResult') {
        span?.done()
        ctx.log.info(`${log}: tool result`, { tool: msg.toolName, ok: true })
      } else {
        span?.error(msg.reply.error)
        ctx.log.warn(`${log}: tool error`, { tool: msg.toolName, error: msg.reply.error })
      }
      const content = msg.reply.type === 'toolResult' ? msg.reply.result : `Tool error: ${msg.reply.error}`
      const updated = [...batch.results, { toolCallId: msg.toolCallId, toolName: msg.toolName, content }]
      const remaining = batch.remaining - 1

      if (remaining > 0) {
        return { state: withTurn(state, { ...turn, pendingBatch: { ...batch, remaining, results: updated } }) }
      }

      const nextLoopCount = turn.toolLoopCount + 1
      if (nextLoopCount >= maxToolLoops) {
        ctx.log.warn(`${log}: tool loop limit reached`, { limit: maxToolLoops })
        turn.requestSpan?.error('Tool loop limit reached')
        return materialize(hooks.onLoopLimit(state, turn.pending, ctx))
      }

      const toolResultMsgs: ApiMessage[] = updated.map(r => ({
        role: 'tool', content: r.content, tool_call_id: r.toolCallId,
      }))
      const nextMessages: ApiMessage[] = [
        ...batch.messagesAtCall,
        { role: 'assistant', content: null, tool_calls: batch.assistantToolCalls },
        ...toolResultMsgs,
      ]

      return startNextTurn(state, nextMessages, nextLoopCount, ctx)
    },

    ...subscriptionCases,
  }

  if (stash) {
    toolLoopCases.invoke = (state: S) => ({ state, stash: true })
  }

  toolLoop = onMessage<M, S>(toolLoopCases) as MessageHandler<M, S>

  return { idle, awaitingLlm, toolLoop }
}
