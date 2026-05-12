import type { ActorDef, ActorRef } from '../../system/types.ts'
import { onLifecycle, onMessage } from '../../system/match.ts'
import type { Tool } from '../../types/llm.ts'
import { ToolRegistrationTopic, type ToolInvokeMsg, type ToolMsg } from '../../types/tools.ts'
import {
  AgentRegistrationTopic,
  AgentCatalogTopic,
  SwitchAgentTopic,
  type AgentDescriptor,
} from './types.ts'

// ─── Message protocol ─────────────────────────────────────────────────────
//
// The actor is its own tool — its self ref is advertised to ToolRegistrationTopic
// for the virtual `switchMode` tool, so it receives ToolInvokeMsg directly.

type AgentRegistryMsg =
  | { type: '_register';   descriptor: AgentDescriptor }
  | { type: '_unregister'; mode:       string }
  | ToolInvokeMsg

type AgentRegistryState = {
  descriptors: Record<string, AgentDescriptor>
}

const initialAgentRegistryState = (): AgentRegistryState => ({ descriptors: {} })

const SWITCH_MODE_TOOL_NAME = 'switch_mode'
const CATALOG_KEY = 'global'

// ─── Schema builder ───────────────────────────────────────────────────────

const buildSwitchModeSchema = (descriptors: Record<string, AgentDescriptor>): Tool => {
  const modes = Object.values(descriptors).filter(d => d.capabilities.userVisible !== false)
  return {
    type: 'function',
    function: {
      name: SWITCH_MODE_TOOL_NAME,
      description:
        'Hand the conversation to a specialized agent. Use when the user asks for ' +
        'work that another mode is better at. The next user message goes to that mode.',
      parameters: {
        type: 'object',
        required: ['mode', 'reason'],
        properties: {
          mode: {
            type:        'string',
            enum:        modes.map(m => m.mode),
            description: modes.map(m => `${m.mode}: ${m.shortDesc}`).join('\n'),
          },
          reason: { type: 'string' },
        },
      },
    },
  }
}

// ─── Actor ─────────────────────────────────────────────────────────────────

export const AgentRegistry = (): ActorDef<AgentRegistryMsg, AgentRegistryState> => {
  const republish = (state: AgentRegistryState, ctx: any) => {
    const userVisible = Object.values(state.descriptors).filter(d => d.capabilities.userVisible !== false)

    ctx.publishRetained(AgentCatalogTopic, CATALOG_KEY, {
      agents: userVisible.map(d => ({ mode: d.mode, displayName: d.displayName, shortDesc: d.shortDesc })),
    })

    // Always publish the tool — single-element enum is harmless. The tool
    // becomes useful once 2+ agents are registered.
    if (userVisible.length === 0) {
      ctx.deleteRetained(ToolRegistrationTopic, SWITCH_MODE_TOOL_NAME, { name: SWITCH_MODE_TOOL_NAME, ref: null })
      return
    }

    ctx.publishRetained(ToolRegistrationTopic, SWITCH_MODE_TOOL_NAME, {
      name:             SWITCH_MODE_TOOL_NAME,
      schema:           buildSwitchModeSchema(state.descriptors),
      ref:              ctx.self as unknown as ActorRef<ToolMsg>,
      mayBeLongRunning: false,
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
        republish(state, ctx)
        return { state }
      },
      stopped: (state, ctx) => {
        ctx.deleteRetained(AgentCatalogTopic, CATALOG_KEY, { agents: [] })
        ctx.deleteRetained(ToolRegistrationTopic, SWITCH_MODE_TOOL_NAME, { name: SWITCH_MODE_TOOL_NAME, ref: null })
        return { state }
      },
    }),

    handler: onMessage<AgentRegistryMsg, AgentRegistryState>({
      _register: (state, msg, ctx) => {
        const next = { ...state, descriptors: { ...state.descriptors, [msg.descriptor.mode]: msg.descriptor } }
        republish(next, ctx)
        ctx.log.info('agent-registry: registered', { mode: msg.descriptor.mode })
        return { state: next }
      },

      _unregister: (state, msg, ctx) => {
        const { [msg.mode]: _, ...descriptors } = state.descriptors
        const next = { ...state, descriptors }
        republish(next, ctx)
        ctx.log.info('agent-registry: unregistered', { mode: msg.mode })
        return { state: next }
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
        if (!mode) {
          msg.replyTo.send({ type: 'toolError', error: 'Missing required argument: mode' })
          return { state }
        }

        const descriptor = state.descriptors[mode]
        if (!descriptor) {
          msg.replyTo.send({ type: 'toolError', error: `Unknown agent mode: ${mode}` })
          return { state }
        }

        const clientId = msg.clientId
        if (!clientId) {
          msg.replyTo.send({ type: 'toolError', error: 'switchMode requires a clientId' })
          return { state }
        }

        ctx.publish(SwitchAgentTopic, {
          clientId,
          mode,
          source: 'llm',
          reason: parsed.reason,
        })

        msg.replyTo.send({
          type:            'toolPending',
          jobId:           crypto.randomUUID(),
          placeholderText: `Switched to ${descriptor.displayName}. Send your next message to start.`,
        })

        return { state }
      },
    }),

    supervision: { type: 'restart', maxRetries: 3, withinMs: 30_000 },
  }
}
