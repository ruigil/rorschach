import type { ActorDef, ActorRef, MessageHandler } from '../../system/types.ts'
import { onLifecycle, onMessage } from '../../system/match.ts'
import type { ToolCollection, ToolEntry, ToolFilter, ToolInvokeMsg, ToolReply } from '../../types/tools.ts'
import { applyToolFilter, ToolRegistrationTopic } from '../../types/tools.ts'
import type {
  ApiMessage,
  LlmProviderMsg,
  LlmProviderReply,
  Tool,
  ToolCall,
} from '../../types/llm.ts'
import { LlmProviderTopic } from '../../types/llm.ts'
import type { MemoryReflectionMsg } from '../../types/memory.ts'
import { ask } from '../../system/ask.ts'
import { ontologySection } from './ontology.ts'

// ─── Options ───

export type ReflectionOptions = {
  model:         string
  intervalMs:    number
  toolFilter?:   ToolFilter
  maxToolLoops?: number
}

// ─── Internal types ───

type PendingBatch = {
  remaining:          number
  results:            Array<{ toolCallId: string; toolName: string; content: string }>
  messagesAtCall:     ApiMessage[]
  assistantToolCalls: ToolCall[]
}

export type ReflectionState = {
  llmRef:        ActorRef<LlmProviderMsg> | null
  tools:         ToolCollection
  requestId:     string | null
  messages:      ApiMessage[] | null
  accumulated:   string
  pendingBatch:  PendingBatch | null
  toolLoopCount: number
  pendingRun:    boolean
}

// ─── System prompt ───

const buildSystemPrompt = (intervalMs: number): string => {
  const intervalMin = Math.round(intervalMs / 60_000)
  const scheduleMin = Math.max(1, intervalMin - 10)

  return `You are a reflection agent for a personal AI assistant. Your task is NOT to transcribe what users said — the consolidation agent already does that. Your task is to identify patterns that users have never explicitly stated but consistently reveal through their behaviour across multiple conversations.\n\n` +

  `## Primary Goal\n` +
  `Discover implicit knowledge about each user by reading across their episodic history. Look for recurring behaviours, consistent tool choices, temporal rhythms, and communication patterns that have not yet been captured as stable facts.\n\n` +

  ontologySection('{userId}') + '\n\n' +

  `## Workflow\n\n` +
  `1. bash ls /workspace/memory/ — discover all user directories\n` +
  `2. For each user found:\n` +
  `   a. Count episodic entries: bash ls /workspace/memory/{userId}/episodic/ | wc -l\n` +
  `      Skip users with fewer than 3 episodic entries — insufficient signal.\n` +
  `   b. Read episodic logs for the past 14 days\n` +
  `   c. Read the current kbase files\n` +
  `   d. Query kgraph to see what is already captured:\n` +
  `      MATCH (u:Entity {name:"{userId}"})-[r]->(m) RETURN type(r), m.name, r.confidence\n` +
  `   e. Identify patterns NOT yet in the graph:\n` +
  `      - Recurring events across 3+ different days → candidate :HAS_HABIT {confidence:"inferred"}\n` +
  `      - Consistent tool/approach use without explicit statement → candidate :PREFERS {confidence:"inferred"}\n` +
  `      - Communication style patterns → update communication.md (kbase note only, no graph)\n` +
  `      - Temporal rhythms (active hours, frequency) → kbase note only\n` +
  `      - Emotional or psychological signals → skip entirely\n` +
  `   f. Apply distillation policy:\n` +
  `      - Single event or mention → skip (episodic only, no graph write)\n` +
  `      - Same activity across 3+ different days → MERGE :HAS_HABIT {confidence:"inferred"}\n` +
  `      - Consistent implicit preference confirmed multiple times → MERGE :PREFERS {confidence:"inferred"}\n` +
  `      - Uncertain or borderline signals → schedule clarifying question via cron_create (run_once:true), no graph write\n` +
  `   g. When writing inferred facts to kbase, mark them: [inferred from pattern]\n` +
  `   h. When a previously inferred graph fact is now confirmed explicitly in episodic history:\n` +
  `      MATCH (u:Entity {name:"{userId}"})-[r:HAS_HABIT]->(h) WHERE r.confidence = "inferred"\n` +
  `      SET r.confidence = "explicit"\n` +
  `      Also remove the [inferred from pattern] marker from the kbase entry.\n` +
  `3. Move to the next user and repeat.\n\n` +

  `## What NOT to do\n` +
  `- Do NOT transcribe conversation content — only extract patterns\n` +
  `- Do NOT write to the episodic log — it is append-only and written by the consolidation agent\n` +
  `- Do NOT create :HAS_HABIT from a single episodic entry\n` +
  `- Do NOT infer facts already explicit in the kgraph (check first)\n` +
  `- Do NOT write :HAS_HABIT relationships — that is the reflection agent's exclusive domain\n` +
  `- Do NOT infer emotional or psychological states — stick to observable behaviour\n` +
  `- Do NOT write to graph with confidence:"inferred" if you are not confident — schedule a question instead\n\n` +

  `## Scheduling Policy for cron_create\n` +
  `1. Call get_current_time to get the current local time.\n` +
  `2. Add ${scheduleMin} minutes to get the target fire time.\n` +
  `3. Build a one-shot cron expression pinned to that exact date and time: \`{MM} {HH} {DD} {month} *\`\n` +
  `   Example: if now is 2026-04-10T14:23+02:00, target = 15:13 on April 10 → expression is \`13 15 10 4 *\`\n` +
  `   Handle hour/day rollover correctly (e.g. 23:50 + 20min = 00:10 next day).\n` +
  `4. Never schedule more than ${intervalMin} minutes in the future — questions due days ahead will already be answered by then.`
}

const buildInitialMessages = (intervalMs: number): ApiMessage[] => [
  { role: 'system', content: buildSystemPrompt(intervalMs) },
  { role: 'user', content: 'Run the weekly reflection pass for all users.' },
]

// ─── Shared tool handlers ───

const toolRegistered = (state: ReflectionState, msg: Extract<MemoryReflectionMsg, { type: '_toolRegistered' }>): { state: ReflectionState } => ({
  state: { ...state, tools: { ...state.tools, [msg.name]: { schema: msg.schema, ref: msg.ref } } },
})

const toolUnregistered = (state: ReflectionState, msg: Extract<MemoryReflectionMsg, { type: '_toolUnregistered' }>): { state: ReflectionState } => {
  const { [msg.name]: _, ...rest } = state.tools
  return { state: { ...state, tools: rest } }
}

// ─── Actor definition ───

export const createMemoryReflectionActor = (options: ReflectionOptions): ActorDef<MemoryReflectionMsg, ReflectionState> => {
  const { model, intervalMs, toolFilter, maxToolLoops = 50 } = options

  let awaitingLlmHandler: MessageHandler<MemoryReflectionMsg, ReflectionState>
  let toolLoopHandler:    MessageHandler<MemoryReflectionMsg, ReflectionState>

  // ─── Start reflection run ───

  const startReflection = (
    state: ReflectionState,
    context: Parameters<MessageHandler<MemoryReflectionMsg, ReflectionState>>[2],
  ): ReturnType<MessageHandler<MemoryReflectionMsg, ReflectionState>> => {
    if (state.llmRef === null) return { state }

    const messages = buildInitialMessages(intervalMs)
    const toolSchemas = Object.values(state.tools).map((e: ToolEntry) => e.schema as Tool)
    const requestId = crypto.randomUUID()

    state.llmRef.send({
      type: 'stream',
      requestId,
      model,
      messages,
      tools: toolSchemas.length > 0 ? toolSchemas : undefined,
      role: 'memory-reflection',
      replyTo: context.self as unknown as ActorRef<LlmProviderReply>,
    })

    context.log.info('memory reflection started')

    return {
      state: { ...state, pendingRun: false, requestId, messages, accumulated: '', pendingBatch: null, toolLoopCount: 0 },
      become: awaitingLlmHandler,
    }
  }

  // ─── Handler: idle ───

  const idleHandler: MessageHandler<MemoryReflectionMsg, ReflectionState> = onMessage<MemoryReflectionMsg, ReflectionState>({
    _reflect: (state, _, context) => startReflection(state, context),

    _llmProvider:      (state, msg) => ({ state: { ...state, llmRef: msg.ref } }),
    _toolRegistered:   toolRegistered,
    _toolUnregistered: toolUnregistered,
  })

  // ─── Handler: awaitingLlm ───

  awaitingLlmHandler = onMessage<MemoryReflectionMsg, ReflectionState>({
    _reflect: (state) => ({ state: { ...state, pendingRun: true } }),

    llmChunk: (state, msg) => {
      if (msg.requestId !== state.requestId) return { state }
      return { state: { ...state, accumulated: state.accumulated + msg.text } }
    },

    llmReasoningChunk: (state) => ({ state }),

    llmToolCalls: (state, msg, context) => {
      if (msg.requestId !== state.requestId) return { state }

      const { calls } = msg

      const assistantToolCalls: ToolCall[] = calls.map(c => ({
        id: c.id,
        type: 'function',
        function: { name: c.name, arguments: c.arguments },
      }))

      const batch: PendingBatch = {
        remaining: calls.length,
        results: [],
        messagesAtCall: state.messages!,
        assistantToolCalls,
      }

      for (const call of calls) {
        const entry = state.tools[call.name]
        if (!entry) {
          context.log.warn('memory reflection: unknown tool', { tool: call.name })
          continue
        }
        context.pipeToSelf(
          ask<ToolInvokeMsg, ToolReply>(
            entry.ref,
            (replyTo) => ({ type: 'invoke', toolName: call.name, arguments: call.arguments, replyTo }),
          ),
          (reply) => ({ type: '_toolResult' as const, toolName: call.name, toolCallId: call.id, reply }),
          (error) => ({
            type: '_toolResult' as const,
            toolName: call.name,
            toolCallId: call.id,
            reply: { type: 'toolError' as const, error: String(error) },
          }),
        )
      }

      return {
        state: { ...state, requestId: null, pendingBatch: batch },
        become: toolLoopHandler,
      }
    },

    llmDone: (state, _, context) => {
      if (_.requestId !== state.requestId) return { state }
      context.log.info('memory reflection done')
      const next = { ...state, requestId: null, messages: null, accumulated: '', pendingBatch: null }
      if (state.pendingRun) return startReflection(next, context)
      return { state: next, become: idleHandler }
    },

    llmError: (state, msg, context) => {
      if (msg.requestId !== state.requestId) return { state }
      context.log.error('memory reflection LLM error', { error: String(msg.error) })
      const next = { ...state, requestId: null, messages: null, accumulated: '', pendingBatch: null }
      if (state.pendingRun) return startReflection(next, context)
      return { state: next, become: idleHandler }
    },

    _llmProvider:      (state, msg) => ({ state: { ...state, llmRef: msg.ref } }),
    _toolRegistered:   toolRegistered,
    _toolUnregistered: toolUnregistered,
  })

  // ─── Handler: toolLoop ───

  toolLoopHandler = onMessage<MemoryReflectionMsg, ReflectionState>({
    _reflect: (state) => ({ state: { ...state, pendingRun: true } }),

    _toolResult: (state, msg, context) => {
      const batch = state.pendingBatch!
      const content = msg.reply.type === 'toolResult' ? msg.reply.result : `Tool error: ${msg.reply.error}`
      const updatedResults = [...batch.results, { toolCallId: msg.toolCallId, toolName: msg.toolName, content }]
      const remaining = batch.remaining - 1

      if (remaining > 0) {
        return { state: { ...state, pendingBatch: { ...batch, remaining, results: updatedResults } } }
      }

      const nextLoopCount = state.toolLoopCount + 1

      if (nextLoopCount >= maxToolLoops) {
        context.log.warn('memory reflection tool loop limit reached', { limit: maxToolLoops })
        const next = { ...state, requestId: null, messages: null, accumulated: '', pendingBatch: null, toolLoopCount: 0 }
        if (state.pendingRun) return startReflection(next, context)
        return { state: next, become: idleHandler }
      }

      const toolResultMsgs: ApiMessage[] = updatedResults.map(r => ({
        role: 'tool', content: r.content, tool_call_id: r.toolCallId,
      }))
      const nextMessages: ApiMessage[] = [
        ...batch.messagesAtCall,
        { role: 'assistant', content: null, tool_calls: batch.assistantToolCalls },
        ...toolResultMsgs,
      ]

      const requestId = crypto.randomUUID()
      const toolSchemas = Object.values(state.tools).map((e: ToolEntry) => e.schema as Tool)

      state.llmRef!.send({
        type: 'stream',
        requestId,
        model,
        messages: nextMessages,
        tools: toolSchemas.length > 0 ? toolSchemas : undefined,
        role: 'memory-reflection',
        replyTo: context.self as unknown as ActorRef<LlmProviderReply>,
      })

      return {
        state: { ...state, requestId, messages: nextMessages, pendingBatch: null, toolLoopCount: nextLoopCount },
        become: awaitingLlmHandler,
      }
    },

    _llmProvider:      (state, msg) => ({ state: { ...state, llmRef: msg.ref } }),
    _toolRegistered:   toolRegistered,
    _toolUnregistered: toolUnregistered,
  })

  return {
    lifecycle: onLifecycle({
      start: (_state, context) => {
        context.subscribe(LlmProviderTopic, (e) => ({
          type: '_llmProvider' as const,
          ref: e.ref,
        }))
        context.subscribe(ToolRegistrationTopic, (e) => {
          if (!applyToolFilter(e.name, toolFilter)) return null
          return e.ref === null
            ? { type: '_toolUnregistered' as const, name: e.name }
            : { type: '_toolRegistered' as const, name: e.name, schema: e.schema, ref: e.ref }
        })
        context.timers.startPeriodicTimer('reflection', { type: '_reflect' }, intervalMs)
        return { state: _state }
      },
    }),

    handler: idleHandler,
  }
}

export const INITIAL_REFLECTION_STATE: ReflectionState = {
  llmRef:        null,
  tools:         {},
  requestId:     null,
  messages:      null,
  accumulated:   '',
  pendingBatch:  null,
  toolLoopCount: 0,
  pendingRun:    false,
}
