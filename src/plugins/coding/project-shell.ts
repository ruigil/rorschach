import { Bash, InMemoryFs, MountableFs, OverlayFs, ReadWriteFs } from 'just-bash'
import type { BashExecResult } from 'just-bash'
import type { ActorDef, SpanHandle } from '../../system/index.ts'
import { defineTool, onMessage, onLifecycle, parseToolArgs } from '../../system/index.ts'
import type { ProjectShellMsg, ProjectShellState } from './types.ts'
import { HttpWsFrameTopic, OutboundUserMessageTopic } from '../../types/events.ts'
import {
  DEFAULT_READ_LINE_LIMIT,
  MAX_READ_LINE_LIMIT,
  MAX_TOOL_RESULT_CHARS,
  WORKSPACE_MOUNT,
  formatReadResult,
  isAllowedMountPath,
  normalizeVirtualPath,
  resolveAllowedPath,
  sliceLineWindow,
  truncateForAgent,
} from './project-shell-path.ts'
import {
  codingGlobTool,
  codingGrepTool,
  codingStrReplaceTool,
  codingWriteTool,
  assertWorkspaceWritePath,
  runGlob,
  runGrep,
  runStrReplace,
  runWrite,
  type GlobToolArgs,
  type GrepToolArgs,
  type StrReplaceToolArgs,
  type WriteToolArgs,
} from './project-shell-tools.ts'

// Re-export helpers/constants used by tests and callers.
export {
  DEFAULT_READ_LINE_LIMIT,
  MAX_READ_LINE_LIMIT,
  MAX_TOOL_RESULT_CHARS,
  WORKSPACE_MOUNT,
  formatNumberedLine,
  formatReadResult,
  isAllowedMountPath,
  normalizeVirtualPath,
  numberLineWindowBody,
  resolveAllowedPath,
  sliceLineWindow,
  truncateForAgent,
} from './project-shell-path.ts'
export type { LineWindow } from './project-shell-path.ts'

export {
  codingGlobTool,
  codingGrepTool,
  codingStrReplaceTool,
  codingWriteTool,
  DEFAULT_GLOB_MAX_RESULTS,
  DEFAULT_GREP_MAX_MATCHES,
  MAX_GLOB_MAX_RESULTS,
  MAX_GREP_MAX_MATCHES,
  MAX_WRITE_CHARS,
  assertWorkspaceWritePath,
  compileGlob,
  compileSearchRegex,
  countOccurrences,
  matchGlob,
  formatGlobResult,
  formatGrepResult,
  lineNumberAtIndex,
} from './project-shell-tools.ts'

/** just-bash sandbox output cap (bytes) before agent-side truncation. */
const BASH_MAX_OUTPUT_BYTES = 512 * 1024

export const codingBashTool = defineTool(
  'bash',
  'Execute a bash command against the mounted filesystems. The project at /rorschach is read-only; /workspace is read-write. Prefer read/grep/glob for inspection and write for workspace files. Large output is truncated.',
  {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The bash command to execute.' },
      cwd: {
        type: 'string',
        description:
          'Working directory for this command (absolute path under /rorschach or /workspace). Defaults to the agent session cwd (independent of the UI terminal).',
      },
      stdin: { type: 'string', description: 'Optional stdin to pipe to the command.' },
    },
    required: ['command'],
  },
)

export const codingReadTool = defineTool(
  'read',
  'Read a UTF-8 file under /rorschach or /workspace. Returns a line window (default 300 lines) with absolute 1-based LINE| prefixes. Use offset/limit to page through large files. Do not include the LINE| prefixes in str_replace old_string.',
  {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Absolute path under /rorschach or /workspace.' },
      offset: {
        type: 'number',
        description: '1-based start line (default 1).',
      },
      limit: {
        type: 'number',
        description: `Max lines to return (default ${DEFAULT_READ_LINE_LIMIT}, max ${MAX_READ_LINE_LIMIT}).`,
      },
    },
    required: ['path'],
  },
)

const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`

const formatExecResult = (result: BashExecResult, cwd?: string): string => {
  const parts: string[] = []
  if (result.stdout) parts.push(result.stdout)
  if (result.stderr) parts.push(`STDERR:\n${result.stderr}`)
  if (result.exitCode !== 0) parts.push(`Exit code: ${result.exitCode}`)
  const resolvedCwd = result.env?.PWD || cwd
  if (resolvedCwd) parts.push(`cwd: ${resolvedCwd}`)
  return truncateForAgent(parts.join('\n') || '(no output)')
}

type BashToolArgs = { command: string; cwd?: string; stdin?: string }
type ReadToolArgs = { path: string; offset?: number; limit?: number }

const parseBashArgs = (raw: string): BashToolArgs => {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      const obj = parsed as Record<string, unknown>
      if (typeof obj.command === 'string') {
        return {
          command: obj.command,
          cwd: typeof obj.cwd === 'string' ? obj.cwd : undefined,
          stdin: typeof obj.stdin === 'string' ? obj.stdin : undefined,
        }
      }
    }
  } catch {
    // fall through: treat entire payload as the command string
  }
  return { command: raw }
}

const replyToolError = (
  replyTo: { send: (msg: { type: 'toolError'; error: string }) => void },
  span: SpanHandle | null,
  error: string,
) => {
  replyTo.send({ type: 'toolError', error })
  span?.error(error)
}

export const ProjectShell = (options: {
  projectRoot: string
  projectMount: string
  workspaceDir: string
}): ActorDef<ProjectShellMsg, ProjectShellState> => {
  const fs = new MountableFs({
    base: new InMemoryFs(),
    mounts: [
      {
        mountPoint: options.projectMount,
        filesystem: new OverlayFs({
          root: options.projectRoot,
          readOnly: true,
          mountPoint: '/',
          maxFileReadSize: BASH_MAX_OUTPUT_BYTES,
        }),
      },
      { mountPoint: WORKSPACE_MOUNT, filesystem: new ReadWriteFs({ root: options.workspaceDir }) },
    ],
  })

  const bash = new Bash({
    fs,
    cwd: options.projectMount,
    executionLimits: {
      maxOutputSize: BASH_MAX_OUTPUT_BYTES,
      maxCommandCount: 2_000,
      maxLoopIterations: 5_000,
    },
  })

  const resolveCwd = (requested: string | undefined, sessionCwd: string): { ok: true; cwd: string } | { ok: false; error: string } => {
    const raw = requested || sessionCwd || options.projectMount
    const normalized = normalizeVirtualPath(raw)
    if (!normalized) {
      return { ok: false, error: `Invalid cwd: ${raw}` }
    }
    if (!isAllowedMountPath(normalized, options.projectMount)) {
      return {
        ok: false,
        error: `cwd must be under ${options.projectMount} or ${WORKSPACE_MOUNT}: ${normalized}`,
      }
    }
    return { ok: true, cwd: normalized }
  }

  /** Prefer shell-reported PWD when it remains under allowed mounts; else keep session cwd. */
  const nextSessionCwd = (result: BashExecResult, sessionCwd: string, fallbackExecCwd?: string): string => {
    const raw = result.env?.PWD || fallbackExecCwd || sessionCwd
    const resolved = resolveCwd(raw, sessionCwd)
    return resolved.ok ? resolved.cwd : sessionCwd
  }

  return {
    initialState: {
      uiCwd: options.projectMount,
      agentCwd: options.projectMount,
    },
    lifecycle: onLifecycle({
      start: (state, ctx) => {
        ctx.subscribe(HttpWsFrameTopic, e => ({ type: '_wsFrame' as const, event: e }))
        return { state }
      },
    }),
    handler: onMessage<ProjectShellMsg, ProjectShellState>({
      _wsFrame: (state, msg, ctx) => {
        const { userId, frame } = msg.event
        const sessionCwd = state.uiCwd || options.projectMount
        const resolved = resolveCwd(frame.cwd, sessionCwd)
        const execCwd = resolved.ok ? resolved.cwd : sessionCwd

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
        const nextCwd = nextSessionCwd(msg.result, state.uiCwd || options.projectMount)
        const reply = {
          type: 'coding.bash.response',
          cmdId: msg.cmdId,
          stdout: msg.result.stdout,
          stderr: msg.result.stderr,
          exitCode: msg.result.exitCode,
          cwd: nextCwd,
        }
        ctx.publish(OutboundUserMessageTopic, { userId: msg.userId, text: JSON.stringify(reply) })
        return { state: { ...state, uiCwd: nextCwd } }
      },

      _wsBashErr: (state, msg, ctx) => {
        const reply = {
          type: 'coding.bash.response',
          cmdId: msg.cmdId,
          error: msg.error,
          exitCode: -1,
          cwd: state.uiCwd,
        }
        ctx.publish(OutboundUserMessageTopic, { userId: msg.userId, text: JSON.stringify(reply) })
        return { state }
      },

      _wsAutocompleteDone: (state, msg, ctx) => {
        const files =
          msg.result.exitCode === 0
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
          const args = parseBashArgs(msg.arguments)
          if (!args.command) {
            replyToolError(msg.replyTo, span, 'Missing required argument: command')
            return { state }
          }

          const cwdResolved = resolveCwd(args.cwd, state.agentCwd || options.projectMount)
          if (!cwdResolved.ok) {
            replyToolError(msg.replyTo, span, cwdResolved.error)
            return { state }
          }

          ctx.log.info('coding bash', { command: args.command, cwd: cwdResolved.cwd })
          const execOpts: { cwd: string; stdin?: string } = { cwd: cwdResolved.cwd }
          if (args.stdin !== undefined) execOpts.stdin = args.stdin

          ctx.pipeToSelf(
            bash.exec(args.command, execOpts),
            result => ({
              type: '_bashDone' as const,
              result,
              replyTo: msg.replyTo,
              span,
              cwd: cwdResolved.cwd,
            }),
            error => ({ type: '_opErr' as const, error: String(error), replyTo: msg.replyTo, span }),
          )
          return { state }
        }

        if (msg.toolName === codingReadTool.name) {
          const parsed = parseToolArgs<ReadToolArgs>(msg.arguments, obj => {
            if (typeof obj.path !== 'string' || !obj.path.trim()) return null
            const offset = typeof obj.offset === 'number' ? obj.offset : undefined
            const limit = typeof obj.limit === 'number' ? obj.limit : undefined
            return { path: obj.path, offset, limit }
          }, 'Missing required argument: path')

          if (!parsed.ok) {
            replyToolError(msg.replyTo, span, parsed.error)
            return { state }
          }

          const args = parsed.value
          const resolved = resolveAllowedPath(args.path, options.projectMount)
          if (!resolved.ok) {
            replyToolError(msg.replyTo, span, resolved.error)
            return { state }
          }

          ctx.log.info('coding read', { path: resolved.path, offset: args.offset, limit: args.limit })
          ctx.pipeToSelf(
            fs.readFile(resolved.path),
            content => {
              if (content.includes('\0')) {
                return {
                  type: '_opErr' as const,
                  error: `Refusing to read binary file: ${resolved.path}`,
                  replyTo: msg.replyTo,
                  span,
                }
              }
              return {
                type: '_opDone' as const,
                text: formatReadResult(resolved.path, content, args.offset, args.limit),
                replyTo: msg.replyTo,
                span,
              }
            },
            error => ({ type: '_opErr' as const, error: String(error), replyTo: msg.replyTo, span }),
          )
          return { state }
        }

        if (msg.toolName === codingGrepTool.name) {
          const parsed = parseToolArgs<GrepToolArgs>(msg.arguments, obj => {
            if (typeof obj.pattern !== 'string' || !obj.pattern) return null
            return {
              pattern: obj.pattern,
              path: typeof obj.path === 'string' ? obj.path : undefined,
              glob: typeof obj.glob === 'string' ? obj.glob : undefined,
              caseInsensitive: typeof obj.caseInsensitive === 'boolean' ? obj.caseInsensitive : undefined,
              maxMatches: typeof obj.maxMatches === 'number' ? obj.maxMatches : undefined,
              context: typeof obj.context === 'number' ? obj.context : undefined,
            }
          }, 'Missing required argument: pattern')

          if (!parsed.ok) {
            replyToolError(msg.replyTo, span, parsed.error)
            return { state }
          }

          const args = parsed.value
          const rootRaw = args.path?.trim() || options.projectMount
          const resolved = resolveAllowedPath(rootRaw, options.projectMount)
          if (!resolved.ok) {
            replyToolError(msg.replyTo, span, resolved.error)
            return { state }
          }

          ctx.log.info('coding grep', {
            pattern: args.pattern,
            path: resolved.path,
            glob: args.glob,
            maxMatches: args.maxMatches,
          })

          ctx.pipeToSelf(
            runGrep(fs, resolved.path, args),
            result =>
              result.ok
                ? { type: '_opDone' as const, text: result.text, replyTo: msg.replyTo, span }
                : { type: '_opErr' as const, error: result.error, replyTo: msg.replyTo, span },
            error => ({ type: '_opErr' as const, error: String(error), replyTo: msg.replyTo, span }),
          )
          return { state }
        }

        if (msg.toolName === codingGlobTool.name) {
          const parsed = parseToolArgs<GlobToolArgs>(msg.arguments, obj => {
            if (typeof obj.pattern !== 'string' || !obj.pattern.trim()) return null
            return {
              pattern: obj.pattern,
              path: typeof obj.path === 'string' ? obj.path : undefined,
              maxResults: typeof obj.maxResults === 'number' ? obj.maxResults : undefined,
            }
          }, 'Missing required argument: pattern')

          if (!parsed.ok) {
            replyToolError(msg.replyTo, span, parsed.error)
            return { state }
          }

          const args = parsed.value
          const rootRaw = args.path?.trim() || options.projectMount
          const resolved = resolveAllowedPath(rootRaw, options.projectMount)
          if (!resolved.ok) {
            replyToolError(msg.replyTo, span, resolved.error)
            return { state }
          }

          ctx.log.info('coding glob', { pattern: args.pattern, path: resolved.path, maxResults: args.maxResults })

          ctx.pipeToSelf(
            runGlob(fs, resolved.path, args),
            result =>
              result.ok
                ? { type: '_opDone' as const, text: result.text, replyTo: msg.replyTo, span }
                : { type: '_opErr' as const, error: result.error, replyTo: msg.replyTo, span },
            error => ({ type: '_opErr' as const, error: String(error), replyTo: msg.replyTo, span }),
          )
          return { state }
        }

        if (msg.toolName === codingWriteTool.name) {
          const parsed = parseToolArgs<WriteToolArgs>(msg.arguments, obj => {
            if (typeof obj.path !== 'string' || !obj.path.trim()) return null
            if (typeof obj.content !== 'string') return null
            return {
              path: obj.path,
              content: obj.content,
              createDirs: typeof obj.createDirs === 'boolean' ? obj.createDirs : undefined,
            }
          }, 'Missing required arguments: path, content')

          if (!parsed.ok) {
            replyToolError(msg.replyTo, span, parsed.error)
            return { state }
          }

          const args = parsed.value
          const normalized = normalizeVirtualPath(args.path)
          if (!normalized) {
            replyToolError(msg.replyTo, span, `Invalid path: ${args.path}`)
            return { state }
          }
          const ws = assertWorkspaceWritePath(normalized)
          if (!ws.ok) {
            replyToolError(msg.replyTo, span, ws.error)
            return { state }
          }

          ctx.log.info('coding write', { path: ws.path, bytes: args.content.length })

          ctx.pipeToSelf(
            runWrite(fs, ws.path, { content: args.content, createDirs: args.createDirs }),
            result =>
              result.ok
                ? { type: '_opDone' as const, text: result.text, replyTo: msg.replyTo, span }
                : { type: '_opErr' as const, error: result.error, replyTo: msg.replyTo, span },
            error => ({ type: '_opErr' as const, error: String(error), replyTo: msg.replyTo, span }),
          )
          return { state }
        }

        if (msg.toolName === codingStrReplaceTool.name) {
          const parsed = parseToolArgs<StrReplaceToolArgs>(msg.arguments, obj => {
            if (typeof obj.path !== 'string' || !obj.path.trim()) return null
            if (typeof obj.old_string !== 'string') return null
            if (typeof obj.new_string !== 'string') return null
            return {
              path: obj.path,
              old_string: obj.old_string,
              new_string: obj.new_string,
              replace_all: typeof obj.replace_all === 'boolean' ? obj.replace_all : undefined,
            }
          }, 'Missing required arguments: path, old_string, new_string')

          if (!parsed.ok) {
            replyToolError(msg.replyTo, span, parsed.error)
            return { state }
          }

          const args = parsed.value
          const normalized = normalizeVirtualPath(args.path)
          if (!normalized) {
            replyToolError(msg.replyTo, span, `Invalid path: ${args.path}`)
            return { state }
          }
          const ws = assertWorkspaceWritePath(normalized)
          if (!ws.ok) {
            replyToolError(msg.replyTo, span, ws.error)
            return { state }
          }

          ctx.log.info('coding str_replace', {
            path: ws.path,
            oldLen: args.old_string.length,
            newLen: args.new_string.length,
            replaceAll: args.replace_all === true,
          })

          ctx.pipeToSelf(
            runStrReplace(fs, ws.path, {
              old_string: args.old_string,
              new_string: args.new_string,
              replace_all: args.replace_all,
            }),
            result =>
              result.ok
                ? { type: '_opDone' as const, text: result.text, replyTo: msg.replyTo, span }
                : { type: '_opErr' as const, error: result.error, replyTo: msg.replyTo, span },
            error => ({ type: '_opErr' as const, error: String(error), replyTo: msg.replyTo, span }),
          )
          return { state }
        }

        replyToolError(msg.replyTo, span, `Unknown tool: ${msg.toolName}`)
        return { state }
      },

      _bashDone: (state, msg) => {
        const nextCwd = nextSessionCwd(msg.result, state.agentCwd || options.projectMount, msg.cwd)
        msg.span?.done({ exitCode: msg.result.exitCode, cwd: nextCwd })
        msg.replyTo.send({
          type: 'toolResult',
          result: { text: formatExecResult(msg.result, nextCwd) },
        })
        return { state: { ...state, agentCwd: nextCwd } }
      },

      _opDone: (state, msg) => {
        msg.span?.done()
        msg.replyTo.send({ type: 'toolResult', result: { text: msg.text } })
        return { state }
      },

      _opErr: (state, msg) => {
        msg.span?.error(msg.error)
        msg.replyTo.send({ type: 'toolError', error: msg.error })
        return { state }
      },
    }),
    supervision: { type: 'restart', maxRetries: 3, withinMs: 30_000 },
  }
}
