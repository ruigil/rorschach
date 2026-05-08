import type { ActorDef, ActorRef } from '../../system/types.ts'
import { onLifecycle, onMessage } from '../../system/match.ts'
import type { ToolCollection, ToolFilter } from '../../types/tools.ts'
import { applyToolFilter, ToolRegistrationTopic } from '../../types/tools.ts'
import type { LlmProviderMsg } from '../../types/llm.ts'
import { LlmProviderTopic } from '../../types/llm.ts'
import type { Tool } from '../../types/llm.ts'
import type { PlannerInputMsg, PlannerSupervisorMsg } from './types.ts'
import { PlannerActiveTopic } from './types.ts'
import {
  createPlannerSessionWorkerActor,
  createInitialPlannerSessionWorkerState,
  type PlannerSessionWorkerOptions,
} from './planner-session-worker.ts'

// ─── Options ───

export type PlannerToolOptions = {
  model?:       string
  plansDir:     string
  maxToolLoops: number
  toolFilter:   ToolFilter
}

// ─── Plan tool schema ───

export const PLAN_TOOL_SCHEMA: Tool = {
  type: 'function',
  function: {
    name: 'plan',
    description: 'Start a structured planning session for a goal. Use this when the user asks you to create a plan, design a roadmap, or work through a complex multi-step goal.',
    parameters: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: 'Clear description of what needs to be planned' },
      },
      required: ['goal'],
    },
  },
}

// ─── State ───

export type PlannerSupervisorState = {
  llmRef:      ActorRef<LlmProviderMsg> | null
  tools:       ToolCollection
  workerIdSeq: number
}

export const createInitialPlannerSupervisorState = (): PlannerSupervisorState => ({
  llmRef:      null,
  tools:       {},
  workerIdSeq: 0,
})

// ─── Actor ───

export const createPlannerSupervisorActor = (
  options: PlannerToolOptions,
): ActorDef<PlannerSupervisorMsg, PlannerSupervisorState> => {
  const {
    model = 'google/gemini-2.5-flash-lite-preview',
    plansDir,
    maxToolLoops,
    toolFilter,
  } = options

  return {
    lifecycle: onLifecycle({
      start: (state, ctx) => {
        ctx.subscribe(LlmProviderTopic, (event) => ({ type: '_llmProvider' as const, ref: event.ref }))

        ctx.subscribe(ToolRegistrationTopic, (event) => {
          if (!applyToolFilter(event.name, toolFilter)) return null
          if ('schema' in event) {
            return {
              type:             '_toolRegistered' as const,
              name:             event.name,
              schema:           event.schema,
              ref:              event.ref,
              mayBeLongRunning: event.mayBeLongRunning,
            }
          }
          return { type: '_toolUnregistered' as const, name: event.name }
        })

        ctx.log.info('planner-supervisor: started', { model, plansDir, maxToolLoops })
        return { state }
      },
    }),

    handler: onMessage<PlannerSupervisorMsg, PlannerSupervisorState>({
      _toolRegistered: (state, msg) => ({
        state: {
          ...state,
          tools: { ...state.tools, [msg.name]: { schema: msg.schema, ref: msg.ref, mayBeLongRunning: msg.mayBeLongRunning } },
        },
      }),

      _toolUnregistered: (state, msg) => {
        const { [msg.name]: _, ...tools } = state.tools
        return { state: { ...state, tools } }
      },

      invoke: (state, msg, ctx) => {
        if (state.llmRef === null) {
          msg.replyTo.send({ type: 'toolError', error: 'Planner not ready' })
          return { state }
        }

        let goal: string
        try { goal = (JSON.parse(msg.arguments) as { goal?: string }).goal ?? msg.arguments }
        catch { goal = msg.arguments }

        const jobId    = crypto.randomUUID()
        const clientId = msg.clientId ?? 'unknown'
        const nextSeq  = state.workerIdSeq + 1

        // Propagate W3C trace context from the invoke headers to the worker.
        // Each worker turn becomes a child span of this parent.
        const parent = ctx.trace.fromHeaders()

        const workerOptions: PlannerSessionWorkerOptions = {
          model, plansDir, maxToolLoops,
          tools:        state.tools,
          llmRef:       state.llmRef,
          clientId, goal, jobId,
          traceId:      parent?.traceId,
          parentSpanId: parent?.spanId,
        }

        const worker = ctx.spawn(
          `planner-session-worker-${nextSeq}`,
          createPlannerSessionWorkerActor(ctx.self as ActorRef<PlannerSupervisorMsg>, workerOptions),
          createInitialPlannerSessionWorkerState(workerOptions),
        )

        ctx.publishRetained(PlannerActiveTopic, clientId, {
          clientId,
          plannerRef: worker as unknown as ActorRef<PlannerInputMsg>,
        })

        msg.replyTo.send({
          type: 'toolPending',
          jobId,
          placeholderText: 'Planning session started.',
        })

        ctx.log.info('planner-supervisor: session spawned', { jobId, clientId, worker: worker.name, goal: goal.slice(0, 100) })

        return { state: { ...state, workerIdSeq: nextSeq } }
      },

      _workerDone: (state, msg, ctx) => {
        ctx.stop(msg.worker)
        return { state }
      },

      _llmProvider: (state, msg) =>
        ({ state: { ...state, llmRef: msg.ref } }),
    }),

    supervision: { type: 'restart', maxRetries: 3, withinMs: 30_000 },
  }
}
