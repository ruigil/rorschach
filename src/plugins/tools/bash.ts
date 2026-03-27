import { Bash, InMemoryFs, MountableFs, OverlayFs, ReadWriteFs } from 'just-bash'
import type { BashOptions, BashExecResult } from 'just-bash'
import type { ActorDef, ActorRef, SpanHandle } from '../../system/types.ts'
import { onMessage } from '../../system/match.ts'
import type { ToolInvokeMsg, ToolReply, ToolSchema } from '../../system/tools.ts'

// ─── Tool schemas ───

export const BASH_TOOL_NAME = 'bash'

export const BASH_SCHEMA: ToolSchema = {
  type: 'function',
  function: {
    name: BASH_TOOL_NAME,
    description: 'Execute a bash command in a sandboxed virtual shell. The filesystem persists across calls within the same session.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The shell command to execute.' },
        stdin: { type: 'string', description: 'Optional stdin to pipe to the command.' },
      },
      required: ['command'],
    },
  },
}

export const WRITE_TOOL_NAME = 'write'

export const WRITE_SCHEMA: ToolSchema = {
  type: 'function',
  function: {
    name: WRITE_TOOL_NAME,
    description: 'Write text content to a file in the virtual filesystem.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file to write.' },
        content: { type: 'string', description: 'UTF-8 text content to write.' },
      },
      required: ['path', 'content'],
    },
  },
}

export const READ_TOOL_NAME = 'read'

export const READ_SCHEMA: ToolSchema = {
  type: 'function',
  function: {
    name: READ_TOOL_NAME,
    description: 'Read text content from a file in the virtual filesystem.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file to read.' },
      },
      required: ['path'],
    },
  },
}

// ─── Internal message protocol ───

export type BashToolMsg =
  | ToolInvokeMsg
  | { type: '_bashDone'; result: BashExecResult; replyTo: ActorRef<ToolReply>; span: SpanHandle | null }
  | { type: '_bashErr'; error: string; replyTo: ActorRef<ToolReply>; span: SpanHandle | null }
  | { type: '_writeDone'; path: string; replyTo: ActorRef<ToolReply>; span: SpanHandle | null }
  | { type: '_writeErr'; error: string; replyTo: ActorRef<ToolReply>; span: SpanHandle | null }
  | { type: '_readDone'; content: string; replyTo: ActorRef<ToolReply>; span: SpanHandle | null }
  | { type: '_readErr'; error: string; replyTo: ActorRef<ToolReply>; span: SpanHandle | null }

// ─── Result formatting ───

const formatExecResult = (result: BashExecResult): string => {
  const parts: string[] = []
  if (result.stdout) parts.push(result.stdout)
  if (result.stderr) parts.push(`STDERR:\n${result.stderr}`)
  if (result.exitCode !== 0) parts.push(`Exit code: ${result.exitCode}`)
  return parts.join('\n') || '(no output)'
}

// ─── Actor definition ───

export const createBashActor = (options?: BashOptions): ActorDef<BashToolMsg, null> => {
  const fs = new MountableFs({ base: new InMemoryFs() });

  // Mount read-only knowledge base
  fs.mount("/home/rigel", new OverlayFs({ root: "/home/rigel", readOnly: true }));
  // Mount read-write workspace
  fs.mount("/workspace", new ReadWriteFs({ root: "/home/rigel/rorschach/workspace" }));

  const bash = new Bash({ fs, cwd: options?.cwd })

  return {
    handler: onMessage<BashToolMsg, null>({
      invoke: (state, message, ctx) => {
        const { toolName, arguments: rawArgs, replyTo } = message

        const parent = ctx.trace.fromHeaders()

        if (toolName === BASH_TOOL_NAME) {
          let args: { command: string; stdin?: string } = { command: '' }
          try { args = JSON.parse(rawArgs) } catch { args = { command: rawArgs } }

          ctx.log.info('bash', { command: args.command })
          const span: SpanHandle | null = parent
            ? ctx.trace.child(parent.traceId, parent.spanId, toolName, { toolName, command: args.command })
            : null

          ctx.pipeToSelf(
            bash.exec(args.command, args.stdin !== undefined ? { stdin: args.stdin } : undefined),
            (result) => ({ type: '_bashDone' as const, result, replyTo, span }),
            (error) => ({ type: '_bashErr' as const, error: String(error), replyTo, span }),
          )
        } else if (toolName === WRITE_TOOL_NAME) {
          const args = JSON.parse(rawArgs) as { path: string; content: string }

          ctx.log.info('bash write', { path: args.path })
          const span: SpanHandle | null = parent
            ? ctx.trace.child(parent.traceId, parent.spanId, toolName, { toolName, path: args.path })
            : null

          ctx.pipeToSelf(
            bash.exec(`cat > ${args.path}`, { stdin: args.content }),
            (_) => ({ type: '_writeDone' as const, path: args.path, replyTo, span }),
            (error) => ({ type: '_writeErr' as const, error: String(error), replyTo, span }),
          )
        } else if (toolName === READ_TOOL_NAME) {
          const args = JSON.parse(rawArgs) as { path: string }

          ctx.log.info('bash read', { path: args.path })
          const span: SpanHandle | null = parent
            ? ctx.trace.child(parent.traceId, parent.spanId, toolName, { toolName, path: args.path })
            : null

          ctx.pipeToSelf(
            bash.exec(`cat ${args.path}`),
            (result) => ({ type: '_readDone' as const, content: result.stdout, replyTo, span }),
            (error) => ({ type: '_readErr' as const, error: String(error), replyTo, span }),
          )
        } else {
          replyTo.send({ type: 'toolError', error: `Unknown tool: ${toolName}` })
        }

        return { state }
      },

      _bashDone: (state, message, context) => {
        const { result, replyTo, span } = message
        span?.done({ exitCode: result.exitCode })
        replyTo.send({ type: 'toolResult', result: formatExecResult(result) })
        return { state }
      },

      _bashErr: (state, message, ctx) => {
        const { error, replyTo, span } = message
        ctx.log.error('bash exec failed', { error })
        span?.error(error)
        replyTo.send({ type: 'toolError', error })
        return { state }
      },

      _writeDone: (state, message) => {
        const { path, replyTo, span } = message
        span?.done({ path })
        replyTo.send({ type: 'toolResult', result: `Written ${path}` })
        return { state }
      },

      _writeErr: (state, message, ctx) => {
        const { error, replyTo, span } = message
        ctx.log.error('bash write failed', { error })
        span?.error(error)
        replyTo.send({ type: 'toolError', error })
        return { state }
      },

      _readDone: (state, message) => {
        const { content, replyTo, span } = message
        span?.done()
        replyTo.send({ type: 'toolResult', result: content })
        return { state }
      },

      _readErr: (state, message, ctx) => {
        const { error, replyTo, span } = message
        ctx.log.error('bash read failed', { error })
        span?.error(error)
        replyTo.send({ type: 'toolError', error })
        return { state }
      },
    }),

    supervision: { type: 'restart', maxRetries: 3, withinMs: 30_000 },
  }
}
