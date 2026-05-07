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
}

export const initialReactTurn = (): ReactTurn => ({
  requestId:     null,
  turnMessages:  null,
  pending:       '',
  pendingBatch:  null,
  toolLoopCount: 0,
  requestSpan:   null,
  llmSpan:       null,
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

export type ReactCompletionAction<M, S> = ActorResult<M, S>

/** Result of buildTurn: either reject with error, or accept with messages and optional state updates. */
export type ReactBuildTurnResult<S> =
  | { error: string }
  | { messages: ApiMessage[]; updates?: (s: S) => S }

/** Result of onUnknownTool: skip the call (with synthetic error feedback) or finish the turn. */
export type ReactUnknownToolAction<M, S> =
  | { kind: 'skip' }
  | { kind: 'finish'; action: ReactCompletionAction<M, S> }

export type ReactSpanPolicy = 'fromHeaders' | 'always' | 'never'

export type ReactLoopHooks<S, M extends { type: string }> = {
  /** Role string sent on every LLM stream message (e.g. 'google', 'memory-recall'). */
  role:         string
  /** Operation name used when creating the per-request root span. */
  spanName:     string
  /** Prefix used in info/warn/error log messages. Defaults to `spanName`. */
  logPrefix?:   string

  // ─── State accessors ───
  llmRef:       (s: S) => ActorRef<LlmProviderMsg> | null
  setLlmRef:    (s: S, ref: ActorRef<LlmProviderMsg> | null) => S
  tools:        (s: S) => ToolCollection
  model:        (s: S) => string
  maxToolLoops: (s: S) => number
  turn:         (s: S) => ReactTurn
  withTurn:     (s: S, t: ReactTurn) => S
  userId:       (s: S) => string
  clientId?:    (s: S) => string | undefined

  // ─── Entry ───
  /** Validate the invoke message and produce the turn's initial messages. */
  buildTurn:     (s: S, msg: ReactInvokeMsg, ctx: ActorContext<M>) => ReactBuildTurnResult<S>

  // ─── Completion handlers ───
  /** Called on `llmDone` after the request span is closed. Must return the next ActorResult (may become idle, stop, etc.). */
  onComplete:    (s: S, finalText: string, ctx: ActorContext<M>) => ReactCompletionAction<M, S>
  /** Called on `llmError`. Spans are already closed by the closure. */
  onLlmError:    (s: S, error: unknown,  ctx: ActorContext<M>) => ReactCompletionAction<M, S>
  /** Called when the tool-loop ceiling is hit. The current `pending` text is passed in. */
  onLoopLimit:   (s: S, finalText: string, ctx: ActorContext<M>) => ReactCompletionAction<M, S>
  /** Called when the LLM emits a tool name not present in `tools(state)`. */
  onUnknownTool: (s: S, name: string, ctx: ActorContext<M>) => ReactUnknownToolAction<M, S>

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

  // mutually-recursive handler refs
  let idle:        MessageHandler<M, S>
  let awaitingLlm: MessageHandler<M, S>
  let toolLoop:    MessageHandler<M, S>

  // ── Helper: send `stream` to LLM and return the new llmSpan ───────────────
  const sendStream = (
    state:     S,
    requestId: string,
    messages:  ApiMessage[],
    ctx:       ActorContext<M>,
  ): SpanHandle | null => {
    const requestSpan = hooks.turn(state).requestSpan
    const llmSpan = requestSpan
      ? ctx.trace.child(requestSpan.traceId, requestSpan.spanId, 'llm-call', { model: hooks.model(state) })
      : null
    const toolSchemas = Object.values(hooks.tools(state)).map((e: ToolEntry) => e.schema as Tool)
    hooks.llmRef(state)!.send({
      type:     'stream',
      requestId,
      model:    hooks.model(state),
      messages,
      tools:    toolSchemas.length > 0 ? toolSchemas : undefined,
      role:     hooks.role,
      clientId: hooks.clientId?.(state),
      replyTo:  ctx.self as unknown as ActorRef<LlmProviderReply>,
    })
    return llmSpan
  }

  // ── Subscription cases (shared across all three handlers) ─────────────────
  const subscriptionCases = {
    _llmProvider: (state: S, msg: Extract<ReactSubscriptionMsg, { type: '_llmProvider' }>) =>
      ({ state: hooks.setLlmRef(state, msg.ref) }),
  }

  // ── Helper: drive the next turn (used by toolLoop after a complete batch) ──
  const startNextTurn = (
    state:        S,
    nextMessages: ApiMessage[],
    nextLoopCount: number,
    ctx:          ActorContext<M>,
  ): ActorResult<M, S> => {
    const requestId = crypto.randomUUID()
    let next = hooks.withTurn(state, {
      ...hooks.turn(state),
      requestId,
      turnMessages:  nextMessages,
      pending:       '',
      pendingBatch:  null,
      toolLoopCount: nextLoopCount,
      llmSpan:       null,
    })
    const llmSpan = sendStream(next, requestId, nextMessages, ctx)
    next = hooks.withTurn(next, { ...hooks.turn(next), llmSpan })
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
      if (!hooks.llmRef(state)) {
        inv.replyTo.send({ type: 'toolError', error: `${log} not ready (no LLM provider).` })
        return { state }
      }

      let next = built.updates ? built.updates(state) : state

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
      next = hooks.withTurn(next, {
        ...hooks.turn(next),
        requestId,
        turnMessages:  built.messages,
        pending:       '',
        pendingBatch:  null,
        toolLoopCount: 0,
        requestSpan,
        llmSpan:       null,
      })
      const llmSpan = sendStream(next, requestId, built.messages, ctx)
      next = hooks.withTurn(next, { ...hooks.turn(next), llmSpan })

      ctx.log.info(`${log}: request started`, { userId: hooks.userId(next) })

      return { state: next, become: awaitingLlm }
    },

    ...subscriptionCases,
  }

  idle = onMessage<M, S>(idleCases) as MessageHandler<M, S>

  // ── awaitingLlm ──────────────────────────────────────────────────────────
  const awaitingLlmCases: any = {
    llmChunk: (state: S, msg: Extract<LlmProviderReply, { type: 'llmChunk' }>, ctx: ActorContext<M>) => {
      const turn = hooks.turn(state)
      if (msg.requestId !== turn.requestId) return { state }
      let next = hooks.withTurn(state, { ...turn, pending: turn.pending + msg.text })
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
      const turn = hooks.turn(state)
      if (msg.requestId !== turn.requestId) return { state }

      turn.llmSpan?.done({ toolCalls: msg.calls.map(c => c.name) })
      ctx.log.info(`${log}: tool calls`, { tools: msg.calls.map(c => c.name) })

      const tools = hooks.tools(state)
      const assistantToolCalls: ToolCall[] = msg.calls.map(c => ({
        id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments },
      }))

      // Partition calls into known/unknown. Unknown calls either short-circuit
      // the turn ('finish') or generate a synthetic toolError feedback ('skip')
      // so the LLM sees the failure on the next turn rather than the loop wedging.
      const knownCalls: typeof msg.calls = []
      const skippedUnknownCalls: typeof msg.calls = []
      for (const call of msg.calls) {
        if (tools[call.name]) {
          knownCalls.push(call)
          continue
        }
        const action = hooks.onUnknownTool(state, call.name, ctx)
        if (action.kind === 'finish') {
          turn.requestSpan?.error(`Tool not available: ${call.name}`)
          ctx.log.warn(`${log}: unknown tool`, { tool: call.name })
          return action.action
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

      const userId   = hooks.userId(state)
      const clientId = hooks.clientId?.(state)

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

      const next = hooks.withTurn(state, { ...turn, requestId: null, llmSpan: null, pendingBatch: batch })
      return { state: next, become: toolLoop }
    },

    llmDone: (state: S, msg: Extract<LlmProviderReply, { type: 'llmDone' }>, ctx: ActorContext<M>) => {
      const turn = hooks.turn(state)
      if (msg.requestId !== turn.requestId) return { state }
      turn.llmSpan?.done()
      turn.requestSpan?.done()
      ctx.log.info(`${log}: done`, { chars: turn.pending.length })
      return hooks.onComplete(state, turn.pending, ctx)
    },

    llmError: (state: S, msg: Extract<LlmProviderReply, { type: 'llmError' }>, ctx: ActorContext<M>) => {
      const turn = hooks.turn(state)
      if (msg.requestId !== turn.requestId) return { state }
      turn.llmSpan?.error(msg.error)
      turn.requestSpan?.error(msg.error)
      ctx.log.error(`${log}: LLM error`, { error: String(msg.error) })
      return hooks.onLlmError(state, msg.error, ctx)
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
      const turn  = hooks.turn(state)
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
        return { state: hooks.withTurn(state, { ...turn, pendingBatch: { ...batch, remaining, results: updated } }) }
      }

      const nextLoopCount = turn.toolLoopCount + 1
      if (nextLoopCount >= hooks.maxToolLoops(state)) {
        ctx.log.warn(`${log}: tool loop limit reached`, { limit: hooks.maxToolLoops(state) })
        turn.requestSpan?.error('Tool loop limit reached')
        return hooks.onLoopLimit(state, turn.pending, ctx)
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
