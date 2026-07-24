import type { ActorDef, ActorRef } from '../../system/index.ts'
import { onLifecycle, onMessage, DynamicAgentActor } from '../../system/index.ts'
import type { LlmTool } from '../../types/llm.ts'
import type { Tool } from '../../types/tools.ts'
import {
  AgentRegistrationTopic,
  type AgentDescriptor,
} from '../../types/agents.ts'
import {
  SwitchAgentTopic,
  SessionLifecycleTopic,
  type SessionLifecycleEvent,
} from './types.ts'
import {
  OutboundBroadcastTopic,
  OutboundUserMessageTopic,
  HttpWsFrameTopic,
  type HttpWsFrameEvent,
  type MessageAttachment,
} from '../../types/events.ts'
import { JobRegistryTopic, type JobLifecycleEvent, type ToolInvokeMsg } from '../../types/tools.ts'

// ─── Message protocol ─────────────────────────────────────────────────────

type AgentRegistryMsg =
  | { type: '_register';   descriptor: AgentDescriptor }
  | { type: '_unregister'; mode:       string }
  | { type: '_sessionLifecycle'; event: SessionLifecycleEvent }
  | { type: '_switchAgent'; userId: string; mode: string; source: 'user' | 'llm' | 'programmatic'; reason?: string }
  | { type: '_jobRegistry'; event: JobLifecycleEvent }
  | { type: '_wsFrame'; event: HttpWsFrameEvent }
  | { type: 'routeMessage'; userId: string; text: string; attachments?: MessageAttachment[]; traceId: string; parentSpanId: string }
  | ToolInvokeMsg

type AgentRegistryState = {
  descriptors: Record<string, AgentDescriptor>
  sessionAgents: Record<string, Record<string, ActorRef<any>>> // userId -> mode -> agentRef
  activeMode: Record<string, string> // userId -> current active mode
  lastUserMessage: Record<string, { text: string; attachments?: MessageAttachment[]; traceId: string; parentSpanId: string }>
  contextStores: Record<string, ActorRef<any>> // userId -> contextStoreRef
  activeJobs: Record<string, { userId: string; toolName: string }> // jobId -> info
}

const initialAgentRegistryState = (): AgentRegistryState => ({
  descriptors: {},
  sessionAgents: {},
  activeMode: {},
  lastUserMessage: {},
  contextStores: {},
  activeJobs: {},
})

const SWITCH_MODE_TOOL_NAME = 'switch_mode'
const CATALOG_KEY = 'global'

// ─── Schema builder ───────────────────────────────────────────────────────

const buildSwitchModeSchema = (descriptors: Record<string, AgentDescriptor>): LlmTool => {
  const modes = Object.values(descriptors).filter(d => d.capabilities.userVisible !== false)
  return {
    type: 'function',
    function: {
      name: SWITCH_MODE_TOOL_NAME,
      description:
        'Switch the conversation to a different specialized agent mode. Use this tool ' +
        'immediately when the user requests a task outside your specialized capabilities ' +
        'or better suited for another mode. Do not attempt to reply to the user directly ' +
        'for tasks outside your mode.',
      parameters: {
        type: 'object',
        required: ['mode', 'reason'],
        properties: {
          mode: {
            type:        'string',
            enum:        modes.map(m => m.mode),
            description: modes.map(m => `${m.mode}: ${m.shortDesc}`).join('\n'),
          },
          reason: { type: 'string', description: 'Brief description of why we are switching modes.' },
        },
      },
    },
  }
}

const buildModeRoutingInstructions = (
  descriptors: Record<string, AgentDescriptor>,
  currentMode: string
): string => {
  const modes = Object.values(descriptors).filter(d => d.capabilities.userVisible !== false)
  const modeDescriptions = modes
    .map(m => `- ${m.mode}: ${m.shortDesc}`)
    .join('\n')

  return [
    `# Mode Routing & Agent Hand-off Instructions`,
    `You are currently operating in the specialized mode: "${currentMode}".`,
    `You have access to the \`switch_mode\` tool, which allows you to transfer the conversation to another specialized agent.`,
    `CRITICAL DIRECTIVE:`,
    `If the user requests a task that is outside your specialized capabilities or belongs to another specialized mode, you MUST call the \`switch_mode\` tool immediately.`,
    `- Do NOT attempt to answer the query or explain that you cannot perform it.`,
    `- Do NOT say "I don't have that tool" or "I am a read-only agent and cannot do that".`,
    `- Simply invoke the \`switch_mode\` tool with the appropriate mode and a brief reason.`,
    `If a request does not fit any other specialized mode, or if you cannot determine which specialized mode to use, switch to "chatbot" mode.`,
    `Available modes and their purposes:`,
    modeDescriptions
  ].join('\n\n')
}

// ─── Helpers ───────────────────────────────────────────────────────────────

const publishModeChanged = (
  userId: string,
  mode: string,
  state: AgentRegistryState,
  ctx: any,
) => {
  const descriptor = state.descriptors[mode]
  const displayName = descriptor?.displayName ?? mode
  ctx.publish(OutboundUserMessageTopic, {
    userId,
    text: JSON.stringify({ type: 'modeChanged', mode, displayName }),
  })
}

const ensureAgent = (
  state: AgentRegistryState,
  userId: string,
  mode: string,
  ctx: any,
): { state: AgentRegistryState; ref: ActorRef<any> | null } => {
  const existing = state.sessionAgents[userId]?.[mode]
  if (existing) return { state, ref: existing }

  const descriptor = state.descriptors[mode]
  if (!descriptor) {
    ctx.log.warn('ensureAgent: unknown agent mode', { mode })
    return { state, ref: null }
  }

  const contextStoreRef = state.contextStores[userId]
  if (!contextStoreRef) {
    ctx.log.warn('ensureAgent: no context store active for user', { userId })
    return { state, ref: null }
  }

  // Inject switch_mode directly as an internal tool
  const switchModeTool: Tool = {
    name: 'switch_mode',
    schema: buildSwitchModeSchema(state.descriptors),
    ref: ctx.self as unknown as ActorRef<any>,
  }

  const routingInstructions = buildModeRoutingInstructions(state.descriptors, mode)
  const descriptorWithSwitch = {
    ...descriptor,
    systemPrompt: [descriptor.systemPrompt, routingInstructions].filter(Boolean).join('\n\n---\n\n'),
    internalTools: [...descriptor.internalTools, switchModeTool],
  }

  const opts = { userId, contextStoreRef }
  const ref = ctx.spawn(`${mode}-${userId}`, DynamicAgentActor(descriptorWithSwitch, opts))

  const userAgents = state.sessionAgents[userId] || {}
  const nextSessionAgents = {
    ...state.sessionAgents,
    [userId]: { ...userAgents, [mode]: ref },
  }

  return {
    state: { ...state, sessionAgents: nextSessionAgents },
    ref,
  }
}

const switchAgentInternal = (
  state: AgentRegistryState,
  userId: string,
  targetMode: string,
  ctx: any,
  source: 'user' | 'llm' | 'programmatic' | 'crashFallback',
  lastMsgToReplay?: { text: string; attachments?: MessageAttachment[]; traceId: string; parentSpanId: string },
): AgentRegistryState => {
  const currentMode = state.activeMode[userId] || 'chatbot'
  const descriptor = state.descriptors[targetMode]
  if (!descriptor) {
    ctx.log.warn('switchAgentInternal: unknown target mode', { targetMode })
    return state
  }

  // 1. Cancel the active agent's turn immediately
  const activeAgent = state.sessionAgents[userId]?.[currentMode]
  if (activeAgent) {
    activeAgent.send({ type: 'cancel' })
  }

  // 2. Ensure target agent is spawned
  const { state: nextState, ref: targetRef } = ensureAgent(state, userId, targetMode, ctx)

  const updatedState = {
    ...nextState,
    activeMode: { ...nextState.activeMode, [userId]: targetMode },
  }

  // 3. Publish modeChanged event to notify Web UI
  publishModeChanged(userId, targetMode, updatedState, ctx)

  // 4. Publish modeActivated event to notify other services
  ctx.publish(SessionLifecycleTopic, {
    type: 'modeActivated',
    userId,
    mode: targetMode,
    previousMode: currentMode,
    source,
    timestamp: Date.now(),
  })

  // 5. Send the replayed message if present
  if (lastMsgToReplay && targetRef) {
    const headers = lastMsgToReplay.traceId && lastMsgToReplay.parentSpanId
      ? { traceparent: `00-${lastMsgToReplay.traceId}-${lastMsgToReplay.parentSpanId}-01` }
      : undefined
    targetRef.send({ type: 'userMessage', text: lastMsgToReplay.text, attachments: lastMsgToReplay.attachments }, headers)
  }

  return updatedState
}

// ─── Actor ─────────────────────────────────────────────────────────────────

export const AgentRegistry = (): ActorDef<AgentRegistryMsg, AgentRegistryState> => {
  const republish = (state: AgentRegistryState, ctx: any) => {
    const userVisible = Object.values(state.descriptors).filter(d => d.capabilities.userVisible !== false)

    ctx.publishRetained(OutboundBroadcastTopic, CATALOG_KEY, {
      type: 'agents',
      key: CATALOG_KEY,
      payload: {
        agents: userVisible.map(d => ({ mode: d.mode, displayName: d.displayName, shortDesc: d.shortDesc })),
      },
    })
  }

  return {
    initialState: initialAgentRegistryState,
    lifecycle: onLifecycle({
      start: (state, ctx) => {
        ctx.subscribe(AgentRegistrationTopic, e =>
          e.type === 'register'
            ? { type: '_register'   as const, descriptor: e.descriptor }
            : { type: '_unregister' as const, mode:       e.mode },
        )
        ctx.subscribe(SessionLifecycleTopic, event => ({ type: '_sessionLifecycle' as const, event }))
        ctx.subscribe(SwitchAgentTopic, e => ({ type: '_switchAgent' as const, userId: e.userId, mode: e.mode, source: e.source, reason: e.reason }))
        ctx.subscribe(JobRegistryTopic, e => ({ type: '_jobRegistry' as const, event: e }))
        ctx.subscribe(HttpWsFrameTopic, e => ({ type: '_wsFrame' as const, event: e }))
        republish(state, ctx)
        return { state }
      },
      stopped: (state, ctx) => {
        ctx.deleteRetained(OutboundBroadcastTopic, CATALOG_KEY, {
          type: 'agents',
          key: CATALOG_KEY,
          payload: { agents: [] },
          isTombstone: true,
        })
        return { state }
      },
      terminated: (state, event, ctx) => {
        const deadName = event.ref.name
        for (const [userId, agents] of Object.entries(state.sessionAgents)) {
          for (const [mode, ref] of Object.entries(agents)) {
            if (ref.name === deadName) {
              const { [mode]: _, ...remaining } = agents
              const nextSessionAgents = { ...state.sessionAgents, [userId]: remaining }
              let nextState = { ...state, sessionAgents: nextSessionAgents }

              if (state.activeMode[userId] === mode) {
                const defaultMode = 'chatbot'
                nextState = {
                  ...nextState,
                  activeMode: { ...nextState.activeMode, [userId]: defaultMode },
                }
                publishModeChanged(userId, defaultMode, nextState, ctx)
                ctx.publish(SessionLifecycleTopic, {
                  type:         'modeActivated',
                  userId,
                  mode:         defaultMode,
                  previousMode: mode,
                  source:       'crashFallback',
                  timestamp:    Date.now(),
                })
              }
              return { state: nextState }
            }
          }
        }
        return { state }
      },
    }),

    handler: onMessage<AgentRegistryMsg, AgentRegistryState>({
      _register: (state, msg, ctx) => {
        const nextDescriptors = { ...state.descriptors, [msg.descriptor.mode]: msg.descriptor }
        const nextState = { ...state, descriptors: nextDescriptors }
        republish(nextState, ctx)

        // Propagate updates to running agents, preserving switch_mode injection
        const switchModeTool: Tool = {
          name: 'switch_mode',
          schema: buildSwitchModeSchema(nextDescriptors),
          ref: ctx.self as unknown as ActorRef<any>,
        }

        for (const [userId, agents] of Object.entries(state.sessionAgents)) {
          const ref = agents[msg.descriptor.mode]
          if (ref) {
            const routingInstructions = buildModeRoutingInstructions(nextDescriptors, msg.descriptor.mode)
            const descriptorWithSwitch = {
              ...msg.descriptor,
              systemPrompt: [msg.descriptor.systemPrompt, routingInstructions].filter(Boolean).join('\n\n---\n\n'),
              internalTools: [...msg.descriptor.internalTools, switchModeTool],
            }
            ref.send({ type: '_updateDescriptor', descriptor: descriptorWithSwitch })
          }
        }
        ctx.log.info('agent-registry: registered', { mode: msg.descriptor.mode })
        return { state: nextState }
      },

      _unregister: (state, msg, ctx) => {
        const { [msg.mode]: _, ...descriptors } = state.descriptors
        const nextState = { ...state, descriptors }
        republish(nextState, ctx)

        // Stop any running agents of this mode
        for (const [userId, agents] of Object.entries(state.sessionAgents)) {
          const ref = agents[msg.mode]
          if (ref) {
            ctx.stop(ref)
          }
        }

        // Clean from sessionAgents
        const sessionAgents = { ...state.sessionAgents }
        for (const userId of Object.keys(sessionAgents)) {
          const { [msg.mode]: _, ...remaining } = sessionAgents[userId] || {}
          sessionAgents[userId] = remaining
        }

        ctx.log.info('agent-registry: unregistered', { mode: msg.mode })
        return { state: { ...nextState, sessionAgents } }
      },

      _sessionLifecycle: (state, msg, ctx) => {
        const { event } = msg
        if (event.type === 'sessionStarted') {
          const nextState = {
            ...state,
            contextStores: { ...state.contextStores, [event.userId]: event.contextStoreRef },
            activeMode: { ...state.activeMode, [event.userId]: event.defaultMode },
          }
          const { state: afterAgent } = ensureAgent(nextState, event.userId, event.defaultMode, ctx)
          publishModeChanged(event.userId, event.defaultMode, afterAgent, ctx)
          return { state: afterAgent }
        }

        if (event.type === 'sessionEnded') {
          const spawned = state.sessionAgents[event.userId] || {}
          for (const ref of Object.values(spawned)) {
            ctx.stop(ref)
          }
          const { [event.userId]: _, ...sessionAgents } = state.sessionAgents
          const { [event.userId]: __, ...contextStores } = state.contextStores
          const { [event.userId]: ___, ...activeMode } = state.activeMode
          return { state: { ...state, sessionAgents, contextStores, activeMode } }
        }

        return { state }
      },

      _switchAgent: (state, msg, ctx) => {
        const nextState = switchAgentInternal(state, msg.userId, msg.mode, ctx, msg.source)
        return { state: nextState }
      },

      _jobRegistry: (state, msg, ctx) => {
        const { event } = msg
        if (event.status === 'running') {
          if (event.userId) {
            return {
              state: {
                ...state,
                activeJobs: {
                  ...state.activeJobs,
                  [event.jobId]: {
                    userId: event.userId,
                    toolName: event.toolName,
                  },
                },
              },
            }
          }
          return { state }
        }

        if (event.status === 'completed' || event.status === 'failed') {
          const cached = state.activeJobs[event.jobId]
          if (!cached) return { state }

          const { userId, toolName } = cached

          const resultText = event.status === 'completed'
            ? (event.result?.text ?? 'Success')
            : (event.error ?? 'Unknown error')

          const userText = `[Job · ${toolName}] ${resultText}`

          if (event.status === 'completed' && event.result) {
            if (event.result.sources?.length) {
              ctx.publish(OutboundUserMessageTopic, {
                userId,
                text: JSON.stringify({ type: 'sources', sources: event.result.sources }),
              })
            }
            if (event.result.attachments?.length) {
              ctx.publish(OutboundUserMessageTopic, {
                userId,
                text: JSON.stringify({ type: 'attachments', attachments: event.result.attachments }),
              })
            }
          }

          // Do not publish cleared here: a producer may re-arm the same jobId
          // (e.g. recurring cron) with running immediately after completed.

          const activeMode = state.activeMode[userId] || 'chatbot'
          const { state: afterAgent, ref } = ensureAgent(state, userId, activeMode, ctx)

          if (ref) {
            ref.send({ type: 'userMessage', text: userText, isInjected: true })
          } else {
            ctx.log.warn('job completion but no agent found to inject into', { userId, activeMode, jobId: event.jobId })
          }

          const { [event.jobId]: _, ...activeJobs } = afterAgent.activeJobs
          return { state: { ...afterAgent, activeJobs } }
        }

        if (event.status === 'cleared') {
          const { [event.jobId]: _, ...activeJobs } = state.activeJobs
          return { state: { ...state, activeJobs } }
        }

        return { state }
      },

      _wsFrame: (state, msg, ctx) => {
        const { userId, frame } = msg.event
        if (!frame.type.startsWith('cognitive.')) return { state }

        if (frame.type === 'cognitive.switchMode') {
          const nextState = switchAgentInternal(state, userId, frame.mode, ctx, 'user')
          return { state: nextState }
        }

        if (frame.type === 'cognitive.cancel') {
          const activeMode = state.activeMode[userId] || 'chatbot'
          const agent = state.sessionAgents[userId]?.[activeMode]
          if (agent) {
            agent.send({ type: 'cancel' })
          }
        }

        if (frame.type === 'cognitive.agents.request') {
          const agents = Object.values(state.descriptors).map(d => ({
            mode: d.mode,
            displayName: d.displayName,
            shortDesc: d.shortDesc,
            userVisible: d.capabilities.userVisible !== false,
            role: d.role,
            model: d.model,
          }))
          ctx.publish(OutboundUserMessageTopic, {
            userId,
            text: JSON.stringify({ type: 'cognitive.agents.updated', agents }),
          })
        }
        return { state }
      },

      routeMessage: (state, msg, ctx) => {
        const lastUserMessage = {
          ...state.lastUserMessage,
          [msg.userId]: { text: msg.text, attachments: msg.attachments, traceId: msg.traceId, parentSpanId: msg.parentSpanId },
        }
        const nextState = { ...state, lastUserMessage }

        const activeMode = nextState.activeMode[msg.userId] || 'chatbot'
        const { state: afterAgent, ref } = ensureAgent(nextState, msg.userId, activeMode, ctx)

        if (ref) {
          const headers = msg.traceId && msg.parentSpanId
            ? { traceparent: `00-${msg.traceId}-${msg.parentSpanId}-01` }
            : undefined
          ref.send({ type: 'userMessage', text: msg.text, attachments: msg.attachments }, headers)
        }
        return { state: afterAgent }
      },

      invoke: (state, msg, ctx) => {
        if (msg.toolName !== SWITCH_MODE_TOOL_NAME) {
          msg.replyTo.send({ type: 'toolError', error: `Unknown tool: ${msg.toolName}` })
          return { state }
        }

        let parsed: { mode?: string; reason?: string }
        try {
          parsed = JSON.parse(msg.arguments) as { mode?: string; reason?: string }
        } catch {
          msg.replyTo.send({ type: 'toolError', error: 'Invalid arguments — expected JSON {mode, reason}' })
          return { state }
        }

        const mode = parsed.mode
        if (!mode || !state.descriptors[mode]) {
          msg.replyTo.send({ type: 'toolError', error: `Invalid mode requested: ${mode}` })
          return { state }
        }

        const lastMsg = state.lastUserMessage[msg.userId]
        const nextState = switchAgentInternal(state, msg.userId, mode, ctx, 'llm', lastMsg)

        msg.replyTo.send({
          type: 'toolResult',
          result: { text: lastMsg ? `Switched to ${state.descriptors[mode].displayName}.` : `Switched to ${state.descriptors[mode].displayName}. Send your next message to start.` },
        })
        return { state: nextState }
      },
    }),

    supervision: { type: 'restart', maxRetries: 3, withinMs: 30_000 },
  }
}
