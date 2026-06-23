import type { ActorContext, ActorDef, ActorResult, Interceptor } from '../../system/index.ts'
import { agentLoop, applyToolFilter, assembleAgentMessages, assembleUserText, idleLoopState, onLifecycle, type ContextView } from '../../system/index.ts'
import { OutboundUserMessageTopic } from '../../types/events.ts'
import { ContextSnapshotTopic, type AgentFactoryOpts } from '../../types/agents.ts'
import type { ApiMessage } from '../../types/llm.ts'
import { ToolRegistrationTopic } from '../../types/tools.ts'
import type { ToolCollection, ToolFinalReply } from '../../types/tools.ts'
import type { CodingAgentMsg, CodingAgentState, CodingAgentOptions } from './types.ts'

const CODING_MODE = 'coding'

const emptyContextView = (userId = ''): ContextView => ({
  userId,
  version: 0,
  recentMessages: [],
  userContext: null,
  toolSummaries: [],
})

const initialState = (): CodingAgentState => ({
  loop: idleLoopState(),
  contextView: emptyContextView(),
  tools: {},
})

const buildSystemPrompt = (projectMount: string): string =>
  `You are the coding agent for a read-only software project.

Project boundary:
- The project is mounted at ${projectMount}.
- You may inspect and explain project files.
- You must not claim to edit, patch, or save project source files.
- Documentation artifacts are generated separately under /workspace/artifacts.

Tools:
- bash: inspect the project with read-oriented shell commands.
- read: read exact file contents.
- update_docs: start a long-running documentation generation job from the user's request.
- show_docs: open the generated documentation index.
- tool_status: check the status of active background jobs (like documentation generation jobs started by update_docs) by their job ID, or list all active jobs when no ID is provided.

Behavior:
- Ground answers in actual files when the user asks about the project.
- Use update_docs when the user asks to generate, refresh, delete or create docs.
- Use show_docs when the user asks to view generated docs.
- If update_docs returns a job id, you can tell the user to ask for a tool status to check progress. Do not do progress updates on your own.
- Be direct and concise.`

export const CodingAgent = (options: CodingAgentOptions, opts: AgentFactoryOpts): ActorDef<CodingAgentMsg, CodingAgentState> => {
  type M = CodingAgentMsg
  type S = CodingAgentState
  type Ctx = ActorContext<M>

  const buildTurnMessages = (state: S, userMsg: ApiMessage): ApiMessage[] =>
    assembleAgentMessages(state.contextView, {
      mode: CODING_MODE,
      systemPrompt: buildSystemPrompt(options.projectMount),
      includeToolSummaries: true,
    }, userMsg)

  const doStartTurn = (
    state: S,
    userText: string,
    isInjected: boolean,
    ctx: Ctx,
  ): ActorResult<M, S> => {
    const userMsg: ApiMessage = { role: 'user', content: userText }
    opts.contextStoreRef.send({
      type: 'append',
      mode: CODING_MODE,
      source: 'user',
      injected: isInjected,
      messages: [userMsg],
    })
    return loop.startTurn(state, {
      messages: buildTurnMessages(state, userMsg),
      userId: opts.userId,
    }, ctx)
  }

  const handleUserMessage = (state: S, msg: Extract<M, { type: 'userMessage' }>, ctx: Ctx): ActorResult<M, S> => {
    const userText = assembleUserText(msg.text, msg.attachments)
    return doStartTurn(state, userText, msg.isInjected || false, ctx)
  }

  const loop = agentLoop<S, M>({
    role: 'coding',
    spanName: 'coding-turn',
    logPrefix: 'coding',
    model: options.model,
    maxToolLoops: options.maxToolLoops ?? 25,
    llmRef: () => opts.llmRef,
    tools: (state) => ({
      ...options.tools,
      ...state.tools,
    }),
    uiEvents: OutboundUserMessageTopic,
    errorMessages: {
      llm: 'The coding agent encountered an error. Please try again.',
      loopLimit: 'Tool loop limit reached in the coding agent. Please try again.',
    },

    onComplete: (state, finalText) => {
      if (finalText) {
        opts.contextStoreRef.send({
          type: 'append',
          mode: CODING_MODE,
          source: 'assistant',
          messages: [{ role: 'assistant', content: finalText }],
        })
      }
      return { state }
    },

	    onError: (state) => ({ state }),

	    onBatchHistoryReady: (state, messages) => {
	      opts.contextStoreRef.send({ type: 'append', mode: CODING_MODE, messages })
	      return { state }
	    },

	    onToolPending: (state, pending) => {
	      const text = pending.placeholderText ?? `Background job started for ${pending.toolName} (jobId=${pending.jobId}).`
	      opts.contextStoreRef.send({
	        type: 'append',
	        mode: CODING_MODE,
	        source: 'assistant',
	        messages: [{ role: 'assistant', content: text }],
	      })
	      return { state }
	    },
	  })

  const hostInterceptor: Interceptor<M, S> = (state, msg, ctx, next) => {
    const m = msg as M

    if (m.type === 'userMessage') {
      if (state.loop.phase !== 'idle') return { state, stash: true }
      return handleUserMessage(state, m as Extract<M, { type: 'userMessage' }>, ctx)
    }

    if (m.type === '_toolRegistered') {
      return {
        state: {
          ...state,
          tools: {
            ...state.tools,
            [m.name]: { name: m.name, schema: m.schema, ref: m.ref, mayBeLongRunning: m.mayBeLongRunning },
          },
        },
      }
    }

    if (m.type === '_toolUnregistered') {
      const { [m.name]: _, ...rest } = state.tools
      return { state: { ...state, tools: rest } }
    }

    if (m.type === '_contextSnapshot') {
      return {
        state: {
          ...state,
          contextView: {
            userId: m.userId,
            version: m.version,
            recentMessages: m.recentMessages,
            userContext: m.userContext,
            toolSummaries: m.toolSummaries,
          },
        },
      }
    }

    return next(state, msg)
  }

  return {
    initialState,
    lifecycle: onLifecycle({
      start: (state, ctx) => {
        ctx.subscribe(ContextSnapshotTopic, (event) => {
          if (event.userId !== opts.userId) return null
          return { type: '_contextSnapshot' as const, ...event }
        })

        const filter = options.toolFilter ?? { allow: ['tool_status', 'switch_mode'] }
        ctx.subscribe(ToolRegistrationTopic, (event) => {
          if (!applyToolFilter(event.name, filter)) return null
          if ('schema' in event && event.ref) {
            return {
              type: '_toolRegistered' as const,
              name: event.name,
              schema: event.schema,
              ref: event.ref,
              mayBeLongRunning: event.mayBeLongRunning,
            }
          }
          return { type: '_toolUnregistered' as const, name: event.name }
        })

        return { state }
      },
    }),
    handler: loop.idle,
    interceptors: [hostInterceptor],
    stashCapacity: 100,
    supervision: { type: 'restart', maxRetries: 3, withinMs: 30_000 },
  }
}

export const CodingAgentFactory = (options: CodingAgentOptions) =>
  (opts: AgentFactoryOpts): ActorDef<CodingAgentMsg, CodingAgentState> => CodingAgent(options, opts)
