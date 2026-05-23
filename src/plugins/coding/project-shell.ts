import { Bash, InMemoryFs, MountableFs, OverlayFs, ReadWriteFs } from 'just-bash'
import type { BashExecResult } from 'just-bash'
import type { ActorDef, SpanHandle } from '../../system/index.ts'
import { defineTool, onMessage } from '../../system/index.ts'
import type { ProjectShellMsg } from './types.ts'

export const codingBashTool = defineTool('bash', 'Execute a read-oriented bash command against the mounted project. The project is mounted read-only at /rorschach. Generated docs live under /workspace/artifacts.', {
  type: 'object',
  properties: {
    command: { type: 'string', description: 'The bash command to execute.' },
    stdin: { type: 'string', description: 'Optional stdin to pipe to the command.' },
  },
  required: ['command'],
})

export const codingReadTool = defineTool('read', 'Read a UTF-8 project or artifact file by absolute path.', {
  type: 'object',
  properties: {
    path: { type: 'string', description: 'Absolute path under /rorschach or /workspace/artifacts.' },
  },
  required: ['path'],
})

const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`

const formatExecResult = (result: BashExecResult): string => {
  const parts: string[] = []
  if (result.stdout) parts.push(result.stdout)
  if (result.stderr) parts.push(`STDERR:\n${result.stderr}`)
  if (result.exitCode !== 0) parts.push(`Exit code: ${result.exitCode}`)
  return parts.join('\n') || '(no output)'
}

export const ProjectShell = (options: {
  projectRoot: string
  projectMount: string
  artifactsDir: string
}): ActorDef<ProjectShellMsg, null> => {
  const fs = new MountableFs({
    base: new InMemoryFs(),
    mounts: [
      { mountPoint: options.projectMount, filesystem: new OverlayFs({ root: options.projectRoot, readOnly: true, mountPoint: "/" }) },
      { mountPoint: "/workspace", filesystem: new ReadWriteFs({ root: options.artifactsDir }) },
    ],
  });

  const bash = new Bash({ fs, cwd: options.projectMount })

  return {
    initialState: null,
    handler: onMessage<ProjectShellMsg, null>({
      invoke: (state, msg, ctx) => {
        const parent = ctx.trace.fromHeaders()
        const span: SpanHandle | null = parent
          ? ctx.trace.child(parent.traceId, parent.spanId, msg.toolName, { toolName: msg.toolName })
          : null

        if (msg.toolName === codingBashTool.name) {
          let args: { command: string; stdin?: string }
          try {
            args = JSON.parse(msg.arguments) as { command: string; stdin?: string }
          } catch {
            args = { command: msg.arguments }
          }
          ctx.log.info('coding bash', {
            command: args.command
          })
          ctx.pipeToSelf(
            bash.exec(args.command, args.stdin !== undefined ? { stdin: args.stdin } : undefined),
            result => ({ type: '_bashDone' as const, result, replyTo: msg.replyTo, span }),
            error => ({ type: '_bashErr' as const, error: String(error), replyTo: msg.replyTo, span }),
          )
          return { state }
        }

        if (msg.toolName === codingReadTool.name) {
          let args: { path: string }
          try {
            args = JSON.parse(msg.arguments) as { path: string }
          } catch {
            msg.replyTo.send({ type: 'toolError', error: 'Invalid arguments: expected { path: string }' })
            return { state }
          }
          ctx.pipeToSelf(
            bash.exec(`cat ${shellQuote(args.path)}`),
            result => {
              if (result.exitCode !== 0) {
                return { type: '_readErr' as const, error: result.stderr || `Failed to read ${args.path}`, replyTo: msg.replyTo, span }
              }
              return { type: '_readDone' as const, content: result.stdout, replyTo: msg.replyTo, span }
            },
            error => ({ type: '_readErr' as const, error: String(error), replyTo: msg.replyTo, span }),
          )
          return { state }
        }

        msg.replyTo.send({ type: 'toolError', error: `Unknown tool: ${msg.toolName}` })
        return { state }
      },

      _bashDone: (state, msg) => {
        msg.span?.done({ exitCode: msg.result.exitCode })
        msg.replyTo.send({ type: 'toolResult', result: { text: formatExecResult(msg.result) } })
        return { state }
      },

      _bashErr: (state, msg) => {
        msg.span?.error(msg.error)
        msg.replyTo.send({ type: 'toolError', error: msg.error })
        return { state }
      },

      _readDone: (state, msg) => {
        msg.span?.done()
        msg.replyTo.send({ type: 'toolResult', result: { text: msg.content } })
        return { state }
      },

      _readErr: (state, msg) => {
        msg.span?.error(msg.error)
        msg.replyTo.send({ type: 'toolError', error: msg.error })
        return { state }
      },
    }),
    supervision: { type: 'restart', maxRetries: 3, withinMs: 30_000 },
  }
}
