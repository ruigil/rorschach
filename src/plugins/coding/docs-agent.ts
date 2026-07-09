import type { ActorContext, ActorDef, ActorRef, ActorResult, Interceptor } from '../../system/index.ts'
import { agentLoop, idleLoopState, onLifecycle, onMessage } from '../../system/index.ts'
import { defineTool } from '../../system/index.ts'
import { OutboundUserMessageTopic } from '../../types/events.ts'
import { LlmProviderTopic } from '../../types/llm.ts'
import { JobRegistryTopic, type ToolCollection, type ToolFinalReply, type ToolMsg } from '../../types/tools.ts'
import type { ApiMessage, LlmProviderMsg } from '../../types/llm.ts'
import type { DocsAgentMsg, DocsAgentOptions, DocsAgentState, DocsJobExecutorMsg, DocsJobExecutorState } from './types.ts'

export const updateDocsTool = defineTool('update_docs', 'Generate or refresh project documentation from the read-only project files. This is a long-running operation and returns a job id immediately.', {
  type: 'object',
  required: ['query'],
  properties: {
    query: { type: 'string', description: 'The user request or documentation goal to satisfy.' },
  },
})

export const showDocsTool = defineTool('show_docs', 'Open the generated documentation index in the documentation workspace.', {
  type: 'object',
  properties: {},
})

const buildSystemPrompt = (projectMount: string): string =>
  `You are the internal documentation agent for a software project.

Project rules:
- The project is mounted read-only at ${projectMount}.
- Generated documentation must be written through write_doc_page.
- You can delete any outdated or incorrect documentation page using delete_doc.
- Never claim to edit source files.
- Use bash/read to inspect the project before writing docs.

Documentation process:
1. Inspect the project structure and the files needed to answer the request.
2. Plan a compact set of documentation pages.
3. Write each page with write_doc_page. Use semantic HTML body content and app-compatible classes where useful.
4. If there are existing outdated or incorrect documentation pages that are no longer needed, you can delete them using delete_doc.

HTML requirements:
- Body content passed to write_doc_page should fit inside the existing .md styling.
- Use h2/h3, p, ul/ol, table, pre/code blocks, and links.
- To include architecture, sequence, flowchart, or class diagrams, use a pre/code block with the "language-mermaid" class containing a valid Mermaid.js diagram definition. For example:
  <pre><code class="language-mermaid">
  graph TD
    A --> B
  </code></pre>
- Do not include full html/head/body in bodyHtml; the tool adds the shell and app stylesheet.
- Include sourcePaths for every page.

Finish with a concise summary of generated pages.`

const parseQuery = (raw: string): string | null => {
  try {
    const parsed = JSON.parse(raw) as { query?: string }
    return typeof parsed.query === 'string' && parsed.query.trim() ? parsed.query.trim() : null
  } catch {
    return raw.trim() || null
  }
}

export const DocsJobExecutor = (
  query: string,
  jobId: string,
  options: DocsAgentOptions & { parentRef: ActorRef<DocsAgentMsg>; llmRef: ActorRef<LlmProviderMsg> | null },
): ActorDef<DocsJobExecutorMsg, DocsJobExecutorState> => {
  type M = DocsJobExecutorMsg
  type S = DocsJobExecutorState
  type Ctx = ActorContext<M>

  const loop = agentLoop<S, M>({
    role: 'docs',
    spanName: 'docs-generation',
    logPrefix: `docs-job-executor-${jobId}`,
    model: options.model,
    maxToolLoops: options.maxToolLoops,
    llmRef: s => s.llmRef,
    tools: options.tools,

    onComplete: (state, finalText, _usage, ctx) => {
      ctx.publishRetained(JobRegistryTopic, jobId, {
        jobId,
        status: 'completed',
        statusText: 'Documentation generation completed.',
        result: {
          text: finalText || 'Documentation generated.',
        },
      })
      options.parentRef.send({ type: '_jobCompleted', jobId })
      return { state }
    },

    onError: (state, err, ctx) => {
      const errorMsg = err.kind === 'llm' ? 'Docs agent encountered an LLM error.' : 'Docs agent reached the tool loop limit.'
      ctx.publishRetained(JobRegistryTopic, jobId, {
        jobId,
        status: 'failed',
        error: errorMsg,
      })
      options.parentRef.send({ type: '_jobFailed', jobId, error: errorMsg })
      return { state }
    },

    onToolResult: (state, result, ctx) => {
      const status = result.reply.type === 'toolResult'
        ? `${result.toolName}: ${result.reply.result.text.slice(0, 180)}`
        : `${result.toolName} failed: ${result.reply.error}`

      const isWritePage = result.toolName === 'write_doc_page' && result.reply.type === 'toolResult'
      const nextPagesWritten = isWritePage ? state.pagesWritten + 1 : state.pagesWritten

      ctx.publishRetained(JobRegistryTopic, jobId, {
        jobId,
        status: 'running',
        toolName: updateDocsTool.name,
        toolRef: options.parentRef as unknown as ActorRef<ToolMsg>,
        startedAt: state.startedAt,
        userId: state.userId,
        statusText: status,
      })

      if (isWritePage) {
        options.parentRef.send({ type: '_pagesWrittenUpdated', jobId, pagesWritten: nextPagesWritten })
      }

      return { state: { ...state, pagesWritten: nextPagesWritten } }
    },
  })

  const hostInterceptor: Interceptor<M, S> = (state, msg, ctx, next) => {
    const m = msg as M
    if (m.type === 'startJob') {
      const messages: ApiMessage[] = [
        { role: 'system', content: buildSystemPrompt(options.projectMount) },
        { role: 'user', content: query },
      ]
      return loop.startTurn({
        ...state,
        startedAt: Date.now(),
        userId: m.userId,
      }, {
        messages,
        userId: m.userId,
      }, ctx)
    }
    if (m.type === '_llmProvider') {
      return { state: { ...state, llmRef: m.ref } }
    }
    return next(state, msg)
  }

  return {
    initialState: () => ({
      loop: idleLoopState(),
      llmRef: options.llmRef,
      pagesWritten: 0,
      startedAt: 0,
    }),
    lifecycle: onLifecycle({
      start: (state, ctx) => {
        ctx.subscribe(LlmProviderTopic, (event) => ({ type: '_llmProvider' as const, ref: event.ref }))
        return { state }
      },
    }),
    handler: loop.idle,
    interceptors: [hostInterceptor],
    stashCapacity: 100,
    supervision: { type: 'restart', maxRetries: 3, withinMs: 30_000 },
  }
}

export const DocsAgent = (options: DocsAgentOptions): ActorDef<DocsAgentMsg, DocsAgentState> => {
  type M = DocsAgentMsg
  type S = DocsAgentState
  type Ctx = ActorContext<M>

  const publishRunning = (ctx: Ctx, jobId: string, query: string, userId: string, statusText: string): void => {
    ctx.publishRetained(JobRegistryTopic, jobId, {
      jobId,
      status: 'running',
      toolName: updateDocsTool.name,
      toolRef: ctx.self as unknown as ActorRef<ToolMsg>,
      startedAt: Date.now(),
      userId,
      statusText,
    })
  }

  const handler = onMessage<M, S>({
    _llmProvider: (state, msg) => {
      return { state: { ...state, llmRef: msg.ref } }
    },

    _pagesWrittenUpdated: (state, msg) => {
      const activeJob = state.activeJobs[msg.jobId]
      if (!activeJob) return { state }
      return {
        state: {
          ...state,
          activeJobs: {
            ...state.activeJobs,
            [msg.jobId]: {
              ...activeJob,
              pagesWritten: msg.pagesWritten,
            },
          },
        },
      }
    },

    _jobCompleted: (state, msg) => {
      const nextJobs = { ...state.activeJobs }
      delete nextJobs[msg.jobId]
      return { state: { ...state, activeJobs: nextJobs } }
    },

    _jobFailed: (state, msg) => {
      const nextJobs = { ...state.activeJobs }
      delete nextJobs[msg.jobId]
      return { state: { ...state, activeJobs: nextJobs } }
    },

    invoke: (state, msg, ctx) => {
      if (msg.toolName === showDocsTool.name) {
        ctx.publish(OutboundUserMessageTopic, {
          userId: msg.userId,
          text: JSON.stringify({ type: 'docWorkspace', artifactName: 'index.html' }),
        })
        msg.replyTo.send({ type: 'toolResult', result: { text: 'Opened documentation index.' } })
        return { state }
      }

      if (msg.toolName !== updateDocsTool.name) {
        msg.replyTo.send({ type: 'toolError', error: `Unknown tool: ${msg.toolName}` })
        return { state }
      }

      if (!state.llmRef) {
        msg.replyTo.send({ type: 'toolError', error: 'Docs agent not ready (no LLM provider).' })
        return { state }
      }

      const query = parseQuery(msg.arguments)
      if (!query) {
        msg.replyTo.send({ type: 'toolError', error: 'Missing required argument: query' })
        return { state }
      }

      const jobId = crypto.randomUUID()
      msg.replyTo.send({
        type: 'toolPending',
        jobId,
        placeholderText: `Documentation generation started (jobId=${jobId}). Use tool_status to check progress.`,
      })

      const executorRef = ctx.spawn(`docs-job-executor-${jobId}`, DocsJobExecutor(query, jobId, {
        model: options.model,
        maxToolLoops: options.maxToolLoops,
        projectMount: options.projectMount,
        tools: options.tools,
        parentRef: ctx.self as ActorRef<DocsAgentMsg>,
        llmRef: state.llmRef,
      })) as ActorRef<DocsJobExecutorMsg>

      const nextState: S = {
        ...state,
        activeJobs: {
          ...state.activeJobs,
          [jobId]: {
            jobId,
            executorRef,
            query,
            userId: msg.userId,
            pagesWritten: 0,
          },
        },
      }

      publishRunning(ctx, jobId, query, msg.userId, 'Starting documentation generation.')

      executorRef.send({ type: 'startJob', userId: msg.userId })

      return { state: nextState }
    },
  })

  return {
    initialState: () => ({ llmRef: null, activeJobs: {} }),
    lifecycle: onLifecycle({
      start: (state, ctx) => {
        ctx.subscribe(LlmProviderTopic, (event) => ({ type: '_llmProvider' as const, ref: event.ref }))
        return { state }
      },
    }),
    handler,
    supervision: { type: 'restart', maxRetries: 3, withinMs: 30_000 },
  }
}
