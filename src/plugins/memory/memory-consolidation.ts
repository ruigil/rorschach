import type { ActorDef, ActorRef, ActorResult, MessageHandler } from '../../system/types.ts'
import { onLifecycle, onMessage } from '../../system/match.ts'
import { MemoryStreamTopic } from '../../types/ws.ts'
import type { MemoryTurnEvent } from '../../types/ws.ts'
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
import type { MemoryConsolidationMsg, UserContextMsg } from '../../types/memory.ts'
import { createUserContextActor, INITIAL_USER_CONTEXT_STATE } from './user-context.ts'
import { ask } from '../../system/ask.ts'
import { ontologySection } from './ontology.ts'

// ─── Options ───

export type MemoryConsolidationOptions = {
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

export type ConsolidationState = {
  llmRef:             ActorRef<LlmProviderMsg> | null
  tools:              ToolCollection

  // Per-user turn buffer
  buffer:             Record<string, MemoryTurnEvent[]>

  // Active consolidation session
  activeUserId:       string | null
  consolidationQueue: string[]

  // Active LLM agent loop
  requestId:          string | null
  turnMessages:       ApiMessage[] | null
  accumulated:        string
  pendingBatch:       PendingBatch | null
  toolLoopCount:      number

  // Spawned user-context actors keyed by userId
  userContexts:       Record<string, ActorRef<UserContextMsg>>
}

// ─── Helpers ───

const localTimeString = (d: Date): string => {
  const offset = -d.getTimezoneOffset()
  const sign = offset >= 0 ? '+' : '-'
  const hh   = String(Math.floor(Math.abs(offset) / 60)).padStart(2, '0')
  const mm   = String(Math.abs(offset) % 60).padStart(2, '0')
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60_000)
  const tzName = Intl.DateTimeFormat().resolvedOptions().timeZone
  return `${local.toISOString().slice(0, 19)}${sign}${hh}:${mm} (${tzName})`
}

// ─── System prompt ───

const buildSystemPrompt = (userId: string, intervalMs: number, now: Date): string => {
  const intervalMin = Math.round(intervalMs / 60_000)
  const scheduleMin = Math.max(1, intervalMin - 10)

  return `You are a user model agent for user "${userId}".\n\n` +

  `## Primary Goal\n` +
  `Build the most complete and accurate knowledge base about this user. The knowledge base is the most important artifact — it is a living document about who this user is. The graph and episodic logs exist to support it.\n\n` +
  `After each consolidation, review the knowledge base for gaps. If important information is missing (identity, preferences, goals, projects, relationships, beliefs, dreams), schedule a proactive question using cron_create (run_once: true) to fill it. These questions exist solely to improve the user model — not to offer help or suggest actions. Do NOT ask things like "Would you like help with X?" or "Do you want me to schedule Y?". Only ask factual questions about who the user is: their background, values, habits, preferences, or ongoing projects. The cron prompt is interpreted by the main react agent, so phrase it as an instruction: e.g. "Ask the user what their preferred deployment workflow is." One focused question per cron job.\n\n` +

  `## Memory Architecture\n\n` +

  `### Knowledge Base  /workspace/memory/${userId}/kbase/{topic}.md\n` +
  `The primary store. One file per topic. Update in-place. Keep entries concise and current.\n` +
  `Suggested topics (create as needed):\n` +
  `- identity.md — name, location, background, profession, life stage\n` +
  `- preferences.md — tools, languages, workflows, communication style\n` +
  `- projects.md — active and past projects, their status and goals\n` +
  `- goals.md — short and long-term goals, aspirations, dreams\n` +
  `- beliefs.md — values, principles, opinions\n` +
  `- relationships.md — people the user mentions and their relevance\n` +
  `- communication.md — how the user communicates (message length, question style, corrections)\n\n` +
  `When recording a fact, link inline to the episodic entry it came from:\n` +
  `  e.g. \`uses Bun as runtime ([2026-03-12](../episodic/2026-03-12.md))\`\n` +
  `Read the file before writing to avoid duplication.\n\n` +
  `Mutable-fact files (projects.md, goals.md, preferences.md) use two sections:\n` +
  `  ## Active   ← present-state facts\n` +
  `  ## Past / Achieved / Abandoned   ← archived facts with date and episodic link\n` +
  `Immutable files (identity.md, beliefs.md, relationships.md) have no past section.\n\n` +

  `### Episodic  /workspace/memory/${userId}/episodic/YYYY-MM-DD.md\n` +
  `Append-only. Record notable events, decisions, and the reasoning behind them.\n` +
  `Skip small talk and trivial exchanges.\n` +
  `Always append — never overwrite. Use bash to do this:\n` +
  `  cat >> /workspace/memory/${userId}/episodic/YYYY-MM-DD.md << 'EOF'\n` +
  `  ## HH:MM — Short title\n` +
  `  Entry text.\n` +
  `  EOF\n\n` +

  `### Knowledge Graph (kgraph)\n` +
  `An index into the knowledge base — not a copy of it. Use it to quickly locate which kbase file contains a given fact.\n\n` +
  ontologySection(userId) + '\n\n' +
  `## Write Order (per consolidation)\n` +
  `1. bash mkdir -p for any new directories\n` +
  `2. Append episodic entry via bash cat >> (never use the write tool for episodic files)\n` +
  `3. Update kbase file(s) with inline episodic link (read first, then write)\n` +
  `4. Query kgraph for contradictions AND for facts that need archiving\n` +
  `5. If a current-state fact has clearly ended (unambiguous from conversation):\n` +
  `   a. Capture the old relationship's source_file\n` +
  `   b. MERGE archive relationship with {since: today's date, source_file}\n` +
  `   c. DELETE the current-state relationship\n` +
  `   d. Move the kbase bullet from ## Active → ## Past / Achieved / Abandoned\n` +
  `   Do NOT schedule a clarifying question for clear lifecycle transitions.\n` +
  `6. Ensure the root anchor exists first: kgraph_upsert { label:"Entity", name:"${userId}" }.\n` +
  `   Always use the exact string "${userId}" — never a generic label like "User" or "the user".\n` +
  `   Then for each additional new node: call kgraph_upsert {label, name, properties}. Capture\n` +
  `   canonicalName from the response — use it (not the name you passed) in all relationship MERGE statements below.\n` +
  `7. Write new relationship MERGEs via kgraph_write using the canonicalName values from step 6.\n` +
  `8. Observe interaction patterns from the turn text (message length, question style, corrections)\n` +
  `   → update /workspace/memory/${userId}/kbase/communication.md (read first, create if missing)\n` +
  `9. Review kbase for gaps → schedule proactive questions via cron_create if needed\n\n` +

  `## Scheduling Policy for cron_create\n` +
  `Current local time: ${localTimeString(now)}\n` +
  `1. Add ${scheduleMin} minutes to the current time above to get the target fire time.\n` +
  `3. Build a one-shot cron expression pinned to that exact date and time: \`{MM} {HH} {DD} {month} *\`\n` +
  `   Example: if now is 2026-04-10T14:23+02:00, target = 15:13 on April 10 → expression is \`13 15 10 4 *\`\n` +
  `   Handle hour/day rollover correctly (e.g. 23:50 + 20min = 00:10 next day).\n` +
  `4. Never schedule more than ${intervalMin} minutes in the future — questions due days ahead will already be answered by then.`
}

const buildMessages = (userId: string, intervalMs: number, turns: MemoryTurnEvent[]): ApiMessage[] => {
  const now = new Date()
  const turnList = turns.map((t, i) => {
    const date = new Date(t.timestamp).toISOString()
    return `Turn ${i + 1} [${date}]\nUser: ${t.userText}\nAssistant: ${t.assistantText}`
  }).join('\n\n')
  return [
    { role: 'system', content: buildSystemPrompt(userId, intervalMs, now) },
    { role: 'user', content: `Please consolidate these conversation turns into memory:\n\n${turnList}` },
  ]
}

// ─── Shared tool handlers ───

const toolRegistered = (state: ConsolidationState, msg: Extract<MemoryConsolidationMsg, { type: '_toolRegistered' }>): { state: ConsolidationState } => ({
  state: { ...state, tools: { ...state.tools, [msg.name]: { schema: msg.schema, ref: msg.ref } } },
})

const toolUnregistered = (state: ConsolidationState, msg: Extract<MemoryConsolidationMsg, { type: '_toolUnregistered' }>): { state: ConsolidationState } => {
  const { [msg.name]: _, ...rest } = state.tools
  return { state: { ...state, tools: rest } }
}

// ─── Actor definition ───

export const createMemoryConsolidationActor = (options: MemoryConsolidationOptions): ActorDef<MemoryConsolidationMsg, ConsolidationState> => {
  const { model, intervalMs, toolFilter, maxToolLoops = 25 } = options

  let awaitingLlmHandler: MessageHandler<MemoryConsolidationMsg, ConsolidationState>
  let toolLoopHandler:    MessageHandler<MemoryConsolidationMsg, ConsolidationState>

  // ─── Start next consolidation from queue ───

  const startNextConsolidation = (
    state: ConsolidationState,
    context: Parameters<MessageHandler<MemoryConsolidationMsg, ConsolidationState>>[2],
  ): ReturnType<MessageHandler<MemoryConsolidationMsg, ConsolidationState>> => {
    if (state.llmRef === null || state.consolidationQueue.length === 0) {
      return { state: { ...state, activeUserId: null }, become: idleHandler }
    }

    const nextUserId = state.consolidationQueue[0]!
    const remainingQueue = state.consolidationQueue.slice(1)
    const snapshotTurns = state.buffer[nextUserId] ?? []

    if (snapshotTurns.length === 0) {
      return startNextConsolidation({ ...state, consolidationQueue: remainingQueue }, context)
    }

    const { [nextUserId]: _dropped, ...remainingBuffer } = state.buffer

    const requestId = crypto.randomUUID()
    const messages = buildMessages(nextUserId, intervalMs, snapshotTurns)
    const toolSchemas = Object.values(state.tools).map((e: ToolEntry) => e.schema as Tool)

    state.llmRef.send({
      type: 'stream',
      requestId,
      model,
      messages,
      tools: toolSchemas.length > 0 ? toolSchemas : undefined,
      role: 'memory-consolidation',
      replyTo: context.self as unknown as ActorRef<LlmProviderReply>,
    })

    context.log.info('memory consolidation started', { userId: nextUserId, turns: snapshotTurns.length })

    return {
      state: {
        ...state,
        buffer: remainingBuffer,
        activeUserId: nextUserId,
        consolidationQueue: remainingQueue,
        requestId,
        turnMessages: messages,
        accumulated: '',
        pendingBatch: null,
        toolLoopCount: 0,
      },
      become: awaitingLlmHandler,
    }
  }

  // ─── Enqueue users with pending turns ───

  const enqueueNewUsers = (state: ConsolidationState): ConsolidationState => {
    const newUserIds = Object.keys(state.buffer).filter(
      uid =>
        (state.buffer[uid]?.length ?? 0) > 0 &&
        uid !== state.activeUserId &&
        !state.consolidationQueue.includes(uid),
    )
    if (newUserIds.length === 0) return state
    return { ...state, consolidationQueue: [...state.consolidationQueue, ...newUserIds] }
  }

  // ─── Shared buffer handler ───

  const bufferTurn = (state: ConsolidationState, msg: Extract<MemoryConsolidationMsg, { type: '_turn' }>): { state: ConsolidationState } => ({
    state: {
      ...state,
      buffer: {
        ...state.buffer,
        [msg.userId]: [...(state.buffer[msg.userId] ?? []), { userId: msg.userId, userText: msg.userText, assistantText: msg.assistantText, timestamp: msg.timestamp }],
      },
    },
  })

  // ─── Handler: idle ───

  const idleHandler: MessageHandler<MemoryConsolidationMsg, ConsolidationState> = onMessage<MemoryConsolidationMsg, ConsolidationState>({
    _turn: bufferTurn,

    _consolidate: (state, _, context) => {
      if (state.llmRef === null) return { state }
      const updated = enqueueNewUsers(state)
      if (updated.consolidationQueue.length === 0) return { state }
      return startNextConsolidation(updated, context)
    },

    _llmProvider:      (state, msg) => ({ state: { ...state, llmRef: msg.ref } }),
    _toolRegistered:   toolRegistered,
    _toolUnregistered: toolUnregistered,
  })

  // ─── Handler: awaitingLlm ───

  awaitingLlmHandler = onMessage<MemoryConsolidationMsg, ConsolidationState>({
    _turn: bufferTurn,

    _consolidate: (state) => ({ state: enqueueNewUsers(state) }),

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
        messagesAtCall: state.turnMessages!,
        assistantToolCalls,
      }

      for (const call of calls) {
        const entry = state.tools[call.name]
        if (!entry) {
          context.log.warn('memory consolidation: unknown tool', { tool: call.name })
          continue
        }
        context.pipeToSelf(
          ask<ToolInvokeMsg, ToolReply>(
            entry.ref,
            (replyTo) => ({ type: 'invoke', toolName: call.name, arguments: call.arguments, replyTo, userId: state.activeUserId ?? undefined }),
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

    llmDone: (state, msg, context) => {
      if (msg.requestId !== state.requestId) return { state }
      const doneUserId = state.activeUserId!
      context.log.info('memory consolidation done', { userId: doneUserId })

      let ucRef = state.userContexts[doneUserId]
      if (!ucRef) {
        const userContextTools = Object.fromEntries(
          Object.entries(state.tools).filter(([n]) => n === 'read' || n === 'kgraph_query'),
        ) as ToolCollection
        ucRef = context.spawn(
          `user-context-${doneUserId}`,
          createUserContextActor({ model, userId: doneUserId, llmRef: state.llmRef!, tools: userContextTools }),
          INITIAL_USER_CONTEXT_STATE,
        )
      }
      ucRef.send({ type: '_run' })
      const userContexts = { ...state.userContexts, [doneUserId]: ucRef }

      return startNextConsolidation(
        { ...state, requestId: null, turnMessages: null, accumulated: '', activeUserId: null, userContexts },
        context,
      ) as ActorResult<MemoryConsolidationMsg, ConsolidationState>
    },

    llmError: (state, msg, context) => {
      if (msg.requestId !== state.requestId) return { state }
      context.log.error('memory consolidation LLM error', { userId: state.activeUserId, error: String(msg.error) })
      return startNextConsolidation(
        { ...state, requestId: null, turnMessages: null, accumulated: '', activeUserId: null },
        context,
      )
    },

    _llmProvider:      (state, msg) => ({ state: { ...state, llmRef: msg.ref } }),
    _toolRegistered:   toolRegistered,
    _toolUnregistered: toolUnregistered,
  })

  // ─── Handler: toolLoop ───

  toolLoopHandler = onMessage<MemoryConsolidationMsg, ConsolidationState>({
    _turn: bufferTurn,

    _consolidate: (state) => ({ state: enqueueNewUsers(state) }),

    _toolResult: (state, msg, context) => {
      const batch = state.pendingBatch!
      const content = msg.reply.type === 'toolResult' ? msg.reply.result : `Tool error: ${msg.reply.error}`
      const updatedResults = [...batch.results, { toolCallId: msg.toolCallId, toolName: msg.toolName, content }]
      const remaining = batch.remaining - 1

      if (remaining > 0) {
        return { state: { ...state, pendingBatch: { ...batch, remaining, results: updatedResults } } }
      }

      // All tools done — check loop limit before looping back
      const nextLoopCount = state.toolLoopCount + 1

      if (nextLoopCount >= maxToolLoops) {
        context.log.warn('memory consolidation tool loop limit reached', { userId: state.activeUserId, limit: maxToolLoops })
        return startNextConsolidation(
          { ...state, requestId: null, turnMessages: null, accumulated: '', pendingBatch: null, activeUserId: null, toolLoopCount: 0 },
          context,
        )
      }

      // Build next LLM request
      const toolResultMsgs: ApiMessage[] = updatedResults.map(r => ({
        role: 'tool', content: r.content, tool_call_id: r.toolCallId,
      }))
      const nextMessages: ApiMessage[] = [
        ...batch.messagesAtCall,
        { role: 'assistant', content: null, tool_calls: batch.assistantToolCalls },
        ...toolResultMsgs,
      ]

      context.log.debug(JSON.stringify(toolResultMsgs))

      const requestId = crypto.randomUUID()
      const toolSchemas = Object.values(state.tools).map((e: ToolEntry) => e.schema as Tool)

      state.llmRef!.send({
        type: 'stream',
        requestId,
        model,
        messages: nextMessages,
        tools: toolSchemas.length > 0 ? toolSchemas : undefined,
        role: 'memory-consolidation',
        replyTo: context.self as unknown as ActorRef<LlmProviderReply>,
      })

      return {
        state: { ...state, requestId, turnMessages: nextMessages, pendingBatch: null, toolLoopCount: nextLoopCount },
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
        context.subscribe(MemoryStreamTopic, (e) => ({
          type: '_turn' as const,
          userId: e.userId,
          userText: e.userText,
          assistantText: e.assistantText,
          timestamp: e.timestamp,
        }))
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
        context.timers.startPeriodicTimer('consolidation', { type: '_consolidate' }, intervalMs)
        return { state: _state }
      },
    }),

    handler: idleHandler,
  }
}

export const INITIAL_CONSOLIDATION_STATE: ConsolidationState = {
  llmRef:             null,
  tools:              {},
  buffer:             {},
  activeUserId:       null,
  consolidationQueue: [],
  requestId:          null,
  turnMessages:       null,
  accumulated:        '',
  pendingBatch:       null,
  toolLoopCount:      0,
  userContexts:       {},
}
