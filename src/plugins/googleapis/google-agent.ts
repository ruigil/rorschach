import type { ActorDef, ActorRef, MessageHandler, SpanHandle } from '../../system/types.ts'
import { onLifecycle, onMessage } from '../../system/match.ts'
import { ask } from '../../system/ask.ts'
import type { ToolCollection, ToolEntry, ToolInvokeMsg, ToolReply } from '../../types/tools.ts'
import type { ToolSchema } from '../../types/tools.ts'
import { LlmProviderTopic } from '../../types/llm.ts'
import type {
  ApiMessage,
  LlmProviderMsg,
  LlmProviderReply,
  Tool,
  ToolCall,
} from '../../types/llm.ts'
import type { GoogleAgentMsg, PendingBatch } from './types.ts'

// ─── Options ───

export type GoogleAgentOptions = {
  model:        string
  maxToolLoops: number
  tools:        ToolCollection
}

// ─── State ───

export type GoogleAgentState = {
  llmRef:        ActorRef<LlmProviderMsg> | null
  model:         string
  maxToolLoops:  number
  tools:         ToolCollection

  requestId:     string | null
  replyTo:       ActorRef<ToolReply> | null
  clientId:      string | undefined
  userId:        string
  turnMessages:  ApiMessage[] | null
  pending:       string
  pendingBatch:  PendingBatch | null
  toolLoopCount: number
  requestSpan:   SpanHandle | null
  llmSpan:       SpanHandle | null
}

// ─── Helpers ───

const todayISO = (): string => new Date().toISOString().slice(0, 10)

const buildSystemPrompt = (): string =>
  `You are a Google Workspace agent. Today is ${todayISO()}.\n\n` +
  `You have access to the user's Gmail, Google Calendar, and Google Drive.\n\n` +
  `Available tools:\n` +
  `- Gmail: gmail_list_messages, gmail_get_message, gmail_send_message, gmail_search\n` +
  `- Calendar: calendar_list_events, calendar_create_event, calendar_update_event, calendar_delete_event\n` +
  `- Drive: drive_list_files, drive_search_files, drive_get_file, drive_download_file, drive_upload_file\n\n` +
  `IMPORTANT — Drive downloads:\n` +
  `drive_download_file saves files to workspace/media/inbound/ and returns an absolute path.\n` +
  `Docs: exportFormat "text" (default) or "pdf". Sheets: "csv" (default) or "pdf". Slides: always pdf.\n` +
  `Chain the returned path with extract_pdf_text (PDFs) or analyze_image (images).\n\n` +
  `IMPORTANT — Drive uploads:\n` +
  `drive_upload_file accepts inline text content OR a filePath to a local file.\n` +
  `When the request contains an absolute path (starts with /), pass it as filePath — do NOT pass it as content or name.\n` +
  `When using filePath, the name parameter is optional (inferred from the filename).\n\n` +
  `IMPORTANT — calendar times:\n` +
  `Always pass datetimes as naive local time with NO UTC offset (e.g. "2025-05-06T14:00:00").\n` +
  `The system automatically applies the user's Google Calendar timezone. Never add +HH:MM or Z.\n\n` +
  `Use the appropriate tools to fulfill the user's request. Reply with a concise summary of what was done.`

const resetTurn = (state: GoogleAgentState): GoogleAgentState => ({
  ...state,
  requestId:     null,
  replyTo:       null,
  clientId:      undefined,
  userId:        '',
  turnMessages:  null,
  pending:       '',
  pendingBatch:  null,
  toolLoopCount: 0,
  requestSpan:   null,
  llmSpan:       null,
})

// ─── Actor ───

export const createGoogleAgentActor = (options: GoogleAgentOptions): ActorDef<GoogleAgentMsg, GoogleAgentState> => {
  const { model, maxToolLoops, tools } = options

  let awaitingLlmHandler: MessageHandler<GoogleAgentMsg, GoogleAgentState>
  let toolLoopHandler:    MessageHandler<GoogleAgentMsg, GoogleAgentState>

  // ─── Handler: idle ───

  const idleHandler: MessageHandler<GoogleAgentMsg, GoogleAgentState> = onMessage<GoogleAgentMsg, GoogleAgentState>({
    invoke: (state, msg, context) => {
      let request: string
      try {
        const args = JSON.parse(msg.arguments) as { request?: string }
        request = args.request ?? msg.arguments
      } catch {
        msg.replyTo.send({ type: 'toolError', error: 'Invalid arguments: expected { request: string }' })
        return { state }
      }

      if (!state.llmRef) {
        msg.replyTo.send({ type: 'toolError', error: 'Google agent not ready (no LLM provider).' })
        return { state }
      }

      const requestId   = crypto.randomUUID()
      const messages: ApiMessage[] = [
        { role: 'system', content: buildSystemPrompt() },
        { role: 'user',   content: request },
      ]
      const toolSchemas = Object.values(state.tools).map((e: ToolEntry) => e.schema as Tool)

      context.log.info('google-agent: request', { request: request.slice(0, 300) })

      const parent     = context.trace.fromHeaders()
      const requestSpan = parent
        ? context.trace.child(parent.traceId, parent.spanId, 'google-agent', { request })
        : null
      const llmSpan = requestSpan
        ? context.trace.child(requestSpan.traceId, requestSpan.spanId, 'llm-call', { model: state.model })
        : null

      state.llmRef.send({
        type: 'stream',
        requestId,
        model: state.model,
        messages,
        tools: toolSchemas.length > 0 ? toolSchemas : undefined,
        role: 'google',
        clientId: msg.clientId,
        replyTo: context.self as unknown as ActorRef<LlmProviderReply>,
      })

      return {
        state: {
          ...state,
          requestId,
          replyTo:       msg.replyTo,
          clientId:      msg.clientId,
          userId:        msg.userId,
          turnMessages:  messages,
          pending:       '',
          pendingBatch:  null,
          toolLoopCount: 0,
          requestSpan,
          llmSpan,
        },
        become: awaitingLlmHandler,
      }
    },

    _llmProviderUpdated: (state, msg) => ({ state: { ...state, llmRef: msg.ref } }),
  })

  // ─── Handler: awaitingLlm ───

  awaitingLlmHandler = onMessage<GoogleAgentMsg, GoogleAgentState>({
    invoke: (state) => ({ state, stash: true }),

    llmChunk: (state, msg) => {
      if (msg.requestId !== state.requestId) return { state }
      return { state: { ...state, pending: state.pending + msg.text } }
    },

    llmReasoningChunk: (state) => ({ state }),

    llmToolCalls: (state, msg, context) => {
      if (msg.requestId !== state.requestId) return { state }

      state.llmSpan?.done({ toolCalls: msg.calls.map(c => c.name) })

      const assistantToolCalls: ToolCall[] = msg.calls.map(c => ({
        id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments },
      }))

      context.log.info('google-agent: tool calls', { tools: msg.calls.map(c => c.name) })

      const unknownCall = msg.calls.find(c => !state.tools[c.name])
      if (unknownCall) {
        context.log.warn('google-agent: unknown tool', { tool: unknownCall.name })
        state.requestSpan?.error(`Tool not available: ${unknownCall.name}`)
        state.replyTo?.send({ type: 'toolError', error: `Tool not available: ${unknownCall.name}` })
        return { state: resetTurn(state), become: idleHandler, unstashAll: true }
      }

      const spans: Record<string, SpanHandle> = {}
      for (const call of msg.calls) {
        if (state.requestSpan) {
          spans[call.id] = context.trace.child(
            state.requestSpan.traceId,
            state.requestSpan.spanId,
            'tool-invoke',
            { toolName: call.name, arguments: call.arguments },
          )
        }
      }

      const batch: PendingBatch = {
        remaining:          msg.calls.length,
        results:            [],
        messagesAtCall:     state.turnMessages!,
        assistantToolCalls,
        spans,
      }

      for (const call of msg.calls) {
        const entry = state.tools[call.name]!
        const toolSpan = spans[call.id]
        context.pipeToSelf(
          ask<ToolInvokeMsg, ToolReply>(
            entry.ref,
            (replyTo) => ({ type: 'invoke', toolName: call.name, arguments: call.arguments, replyTo, clientId: state.clientId, userId: state.userId }),
            undefined,
            toolSpan ? context.trace.injectHeaders(toolSpan) : undefined,
          ),
          (reply): GoogleAgentMsg => ({ type: '_toolResult', toolName: call.name, toolCallId: call.id, reply }),
          (error): GoogleAgentMsg => ({
            type: '_toolResult', toolName: call.name, toolCallId: call.id,
            reply: { type: 'toolError', error: String(error) },
          }),
        )
      }

      return {
        state: { ...state, requestId: null, llmSpan: null, pendingBatch: batch },
        become: toolLoopHandler,
      }
    },

    llmDone: (state, msg, context) => {
      if (msg.requestId !== state.requestId) return { state }
      context.log.info('google-agent: done', { chars: state.pending.length })
      state.llmSpan?.done()
      state.requestSpan?.done()
      state.replyTo?.send({ type: 'toolResult', result: state.pending || '(done)' })
      return { state: resetTurn(state), become: idleHandler, unstashAll: true }
    },

    llmError: (state, msg, context) => {
      if (msg.requestId !== state.requestId) return { state }
      context.log.error('google-agent LLM error', { error: String(msg.error) })
      state.llmSpan?.error(msg.error)
      state.requestSpan?.error(msg.error)
      state.replyTo?.send({ type: 'toolError', error: 'Google agent encountered an LLM error.' })
      return { state: resetTurn(state), become: idleHandler, unstashAll: true }
    },

    _llmProviderUpdated: (state, msg) => ({ state: { ...state, llmRef: msg.ref } }),
  })

  // ─── Handler: toolLoop ───

  toolLoopHandler = onMessage<GoogleAgentMsg, GoogleAgentState>({
    invoke: (state) => ({ state, stash: true }),

    _toolResult: (state, msg, context) => {
      const batch = state.pendingBatch!
      const span  = batch.spans[msg.toolCallId]
      if (msg.reply.type === 'toolResult') {
        span?.done()
        context.log.info('google-agent: tool result', { tool: msg.toolName, ok: true })
      } else {
        span?.error(msg.reply.error)
        context.log.warn('google-agent: tool error', { tool: msg.toolName, error: msg.reply.error })
      }
      const content = msg.reply.type === 'toolResult' ? msg.reply.result : `Tool error: ${msg.reply.error}`
      const updated = [...batch.results, { toolCallId: msg.toolCallId, toolName: msg.toolName, content }]
      const remaining = batch.remaining - 1

      if (remaining > 0) {
        return { state: { ...state, pendingBatch: { ...batch, remaining, results: updated } } }
      }

      const nextLoopCount = state.toolLoopCount + 1
      if (nextLoopCount >= maxToolLoops) {
        context.log.warn('google-agent tool loop limit reached', { limit: maxToolLoops })
        state.replyTo?.send({ type: 'toolError', error: 'Tool loop limit reached.' })
        return { state: resetTurn(state), become: idleHandler, unstashAll: true }
      }

      const toolResultMsgs: ApiMessage[] = updated.map(r => ({
        role: 'tool', content: r.content, tool_call_id: r.toolCallId,
      }))
      const nextMessages: ApiMessage[] = [
        ...batch.messagesAtCall,
        { role: 'assistant', content: null, tool_calls: batch.assistantToolCalls },
        ...toolResultMsgs,
      ]

      const requestId   = crypto.randomUUID()
      const toolSchemas = Object.values(state.tools).map((e: ToolEntry) => e.schema as Tool)

      const llmSpan = state.requestSpan
        ? context.trace.child(state.requestSpan.traceId, state.requestSpan.spanId, 'llm-response', { model: state.model })
        : null

      state.llmRef!.send({
        type: 'stream',
        requestId,
        model: state.model,
        messages: nextMessages,
        tools: toolSchemas.length > 0 ? toolSchemas : undefined,
        role: 'google',
        clientId: state.clientId,
        replyTo: context.self as unknown as ActorRef<LlmProviderReply>,
      })

      return {
        state: {
          ...state,
          requestId,
          turnMessages:  nextMessages,
          pending:       '',
          pendingBatch:  null,
          toolLoopCount: nextLoopCount,
          llmSpan,
        },
        become: awaitingLlmHandler,
      }
    },

    _llmProviderUpdated: (state, msg) => ({ state: { ...state, llmRef: msg.ref } }),
  })

  return {
    lifecycle: onLifecycle({
      start: (_state, context) => {
        context.subscribe(LlmProviderTopic, (e) => ({ type: '_llmProviderUpdated' as const, ref: e.ref }))
        return { state: _state }
      },
    }),

    handler: idleHandler,

    stashCapacity: 50,
    supervision:   { type: 'restart', maxRetries: 3, withinMs: 30_000 },
  }
}

export const createInitialGoogleAgentState = (options: GoogleAgentOptions): GoogleAgentState => ({
  llmRef:        null,
  model:         options.model,
  maxToolLoops:  options.maxToolLoops,
  tools:         options.tools,
  requestId:     null,
  replyTo:       null,
  clientId:      undefined,
  userId:        '',
  turnMessages:  null,
  pending:       '',
  pendingBatch:  null,
  toolLoopCount: 0,
  requestSpan:   null,
  llmSpan:       null,
})
