import { Bash, InMemoryFs, MountableFs, OverlayFs, ReadWriteFs } from 'just-bash'
import type { BashExecResult } from 'just-bash'
import type { ActorDef, SpanHandle } from '../../system/index.ts'
import { defineTool, onMessage, onLifecycle } from '../../system/index.ts'
import type { ProjectShellMsg, ProjectShellState } from './types.ts'
import { HttpWsFrameTopic, OutboundUserMessageTopic } from '../../types/events.ts'

export const codingBashTool = defineTool('bash', 'Execute a read-oriented bash command against the mounted project. The project is mounted read-only at /rorschach. Workspace files live under /workspace, and generated docs live under /workspace/artifacts.', {
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
    path: { type: 'string', description: 'Absolute path under /rorschach or /workspace.' },
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
  workspaceDir: string
  artifactsDir: string
}): ActorDef<ProjectShellMsg, ProjectShellState> => {
  const fs = new MountableFs({
    base: new InMemoryFs(),
    mounts: [
      { mountPoint: options.projectMount, filesystem: new OverlayFs({ root: options.projectRoot, readOnly: true, mountPoint: "/" }) },
      { mountPoint: "/workspace", filesystem: new ReadWriteFs({ root: options.workspaceDir }) },
    ],
  });

  const bash = new Bash({ fs, cwd: options.projectMount })

  return {
    initialState: { cwd: options.projectMount },
    lifecycle: onLifecycle({
      start: (state, ctx) => {
        ctx.subscribe(HttpWsFrameTopic, e => ({ type: '_wsFrame' as const, event: e }))
        return { state }
      }
    }),
    handler: onMessage<ProjectShellMsg, ProjectShellState>({
      _wsFrame: (state, msg, ctx) => {
        const { userId, frame } = msg.event
        const execCwd = frame.cwd || state.cwd || options.projectMount

        if (frame.type === 'coding.bash.command') {
          ctx.pipeToSelf(
            bash.exec(frame.command, { cwd: execCwd }),
            result => ({ type: '_wsBashDone' as const, result, userId, cmdId: frame.cmdId }),
            error => ({ type: '_wsBashErr' as const, error: String(error), userId, cmdId: frame.cmdId }),
          )
          return { state }
        }

        if (frame.type === 'coding.bash.autocomplete') {
          ctx.pipeToSelf(
            bash.exec(`ls -F ${shellQuote(frame.directory || '.')}`, { cwd: execCwd }),
            result => ({ type: '_wsAutocompleteDone' as const, result, userId, cmdId: frame.cmdId }),
            error => ({ type: '_wsAutocompleteErr' as const, error: String(error), userId, cmdId: frame.cmdId }),
          )
          return { state }
        }

        return { state }
      },

      _wsBashDone: (state, msg, ctx) => {
        const nextCwd = msg.result.env?.PWD || state.cwd
        const reply = {
          type: 'coding.bash.response',
          cmdId: msg.cmdId,
          stdout: msg.result.stdout,
          stderr: msg.result.stderr,
          exitCode: msg.result.exitCode,
          cwd: nextCwd,
        }
        ctx.publish(OutboundUserMessageTopic, { userId: msg.userId, text: JSON.stringify(reply) })
        return { state: { ...state, cwd: nextCwd } }
      },

      _wsBashErr: (state, msg, ctx) => {
        const reply = {
          type: 'coding.bash.response',
          cmdId: msg.cmdId,
          error: msg.error,
          exitCode: -1,
          cwd: state.cwd,
        }
        ctx.publish(OutboundUserMessageTopic, { userId: msg.userId, text: JSON.stringify(reply) })
        return { state }
      },

      _wsAutocompleteDone: (state, msg, ctx) => {
        const files = msg.result.exitCode === 0
          ? msg.result.stdout.split('\n').map(f => f.trim()).filter(Boolean)
          : []
        const reply = {
          type: 'coding.bash.autocomplete.response',
          cmdId: msg.cmdId,
          files,
        }
        ctx.publish(OutboundUserMessageTopic, { userId: msg.userId, text: JSON.stringify(reply) })
        return { state }
      },

      _wsAutocompleteErr: (state, msg, ctx) => {
        const reply = {
          type: 'coding.bash.autocomplete.response',
          cmdId: msg.cmdId,
          files: [],
        }
        ctx.publish(OutboundUserMessageTopic, { userId: msg.userId, text: JSON.stringify(reply) })
        return { state }
      },

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
