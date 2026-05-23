import type { ActorContext, ActorDef, ActorRef, ActorResult, Interceptor } from '../../system/index.ts'
import { agentLoop, idleLoopState, onLifecycle } from '../../system/index.ts'
import { defineTool } from '../../system/index.ts'
import { OutboundMessageTopic } from '../../types/events.ts'
import { LlmProviderTopic } from '../../types/llm.ts'
import { JobRegistryTopic, type ToolCollection, type ToolFinalReply, type ToolMsg } from '../../types/tools.ts'
import type { ApiMessage } from '../../types/llm.ts'
import type { DocsAgentMsg, DocsAgentOptions, DocsAgentState } from './types.ts'

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

export const DocsAgent = (options: DocsAgentOptions): ActorDef<DocsAgentMsg, DocsAgentState> => {
  type M = DocsAgentMsg
  type S = DocsAgentState
  type Ctx = ActorContext<M>

  const publishRunning = (ctx: Ctx, state: S, statusText: string): void => {
    const job = state.currentJob
    if (!job) return
    ctx.publishRetained(JobRegistryTopic, job.jobId, {
      jobId: job.jobId,
      status: 'running',
      toolName: updateDocsTool.name,
      toolRef: ctx.self as unknown as ActorRef<ToolMsg>,
      startedAt: Date.now(),
      clientId: job.clientId,
      userId: job.userId,
      statusText,
    })
  }

  const handleInvoke = (state: S, msg: Extract<M, { type: 'invoke' }>, ctx: Ctx): ActorResult<M, S> => {
    if (msg.toolName === showDocsTool.name) {
      if (msg.clientId) {
        ctx.publish(OutboundMessageTopic, {
          clientId: msg.clientId,
          text: JSON.stringify({ type: 'docWorkspace', artifactName: 'index.html' }),
        })
      }
      msg.replyTo.send({ type: 'toolResult', result: { text: 'Opened documentation index.' } })
      return { state }
    }

    if (msg.toolName !== updateDocsTool.name) {
      msg.replyTo.send({ type: 'toolError', error: `Unknown tool: ${msg.toolName}` })
      return { state }
    }

    if (state.loop.phase !== 'idle' || state.currentJob) {
      msg.replyTo.send({ type: 'toolError', error: 'Documentation generation is already running.' })
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

    const nextState: S = {
      ...state,
      currentJob: {
        jobId,
        query,
        clientId: msg.clientId,
        userId: msg.userId,
        pagesWritten: 0,
      },
    }
    publishRunning(ctx, nextState, 'Starting documentation generation.')

    const messages: ApiMessage[] = [
      { role: 'system', content: buildSystemPrompt(options.projectMount) },
      { role: 'user', content: query },
    ]
    return loop.startTurn(nextState, {
      messages,
      userId: msg.userId,
      clientId: msg.clientId,
    }, ctx)
  }

  const loop = agentLoop<S, M>({
    role: 'docs',
    spanName: 'docs-generation',
    logPrefix: 'docs-agent',
    model: options.model,
    maxToolLoops: options.maxToolLoops,
    llmRef: s => s.llmRef,
    tools: options.tools,

    onComplete: (state, finalText, _usage, ctx) => {
      const job = state.currentJob
      if (job) {
        ctx.publishRetained(JobRegistryTopic, job.jobId, {
          jobId: job.jobId,
          status: 'completed',
          statusText: 'Documentation generation completed.',
          result: {
            text: finalText || `Documentation generated in ${options.artifactsDir}/index.html.`,
          },
        })
      }
      return { state: { ...state, currentJob: null } }
    },

    onError: (state, err, ctx) => {
      const job = state.currentJob
      if (job) {
        ctx.publishRetained(JobRegistryTopic, job.jobId, {
          jobId: job.jobId,
          status: 'failed',
          error: err.kind === 'llm' ? 'Docs agent encountered an LLM error.' : 'Docs agent reached the tool loop limit.',
        })
      }
      return { state: { ...state, currentJob: null } }
    },

    onToolResult: (state, result, ctx) => {
      if (!state.currentJob) return { state }
      const status = result.reply.type === 'toolResult'
        ? `${result.toolName}: ${result.reply.result.text.slice(0, 180)}`
        : `${result.toolName} failed: ${result.reply.error}`
      const nextState = result.toolName === 'write_doc_page' && result.reply.type === 'toolResult'
        ? { ...state, currentJob: { ...state.currentJob, pagesWritten: state.currentJob.pagesWritten + 1 } }
        : state
      publishRunning(ctx, nextState, status)
      return { state: nextState }
    },
  })

  const hostInterceptor: Interceptor<M, S> = (state, msg, ctx, next) => {
    const m = msg as M
    if (m.type === 'invoke') return handleInvoke(state, m as Extract<M, { type: 'invoke' }>, ctx)
    if (m.type === '_llmProvider') return { state: { ...state, llmRef: m.ref } }
    return next(state, msg)
  }

  return {
    initialState: () => ({ loop: idleLoopState(), llmRef: null, currentJob: null }),
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
