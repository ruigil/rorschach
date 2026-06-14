import { Bash, InMemoryFs, MountableFs, OverlayFs, ReadWriteFs } from 'just-bash'
import type { BashOptions, BashExecResult } from 'just-bash'
import type { ActorDef, ActorRef, SpanHandle } from '../../system/index.ts'
import { onMessage } from '../../system/index.ts'
import { defineTool } from '../../system/index.ts'
import type { ToolInvokeMsg, ToolReply } from '../../types/tools.ts'

// ─── Tool schemas ───

export const bashTool = defineTool('bash', 'Execute a bash command in a sandboxed virtual shell. The filesystem persists across calls within the same session.', {
  type: 'object',
  properties: {
    command: { type: 'string', description: 'The shell command to execute.' },
    stdin: { type: 'string', description: 'Optional stdin to pipe to the command.' },
  },
  required: ['command'],
})

export const writeTool = defineTool('write', 'Write text content to a file in the virtual filesystem.', {
  type: 'object',
  properties: {
    path: { type: 'string', description: 'Path to the file to write.' },
    content: { type: 'string', description: 'UTF-8 text content to write.' },
  },
  required: ['path', 'content'],
})

export const readTool = defineTool('read', 'Read text content from a file in the virtual filesystem.', {
  type: 'object',
  properties: {
    path: { type: 'string', description: 'Path to the file to read.' },
  },
  required: ['path'],
})

export const editTool = defineTool('edit', 'Safely edit a file in the virtual filesystem by searching for a unique block of text and replacing it. The operation fails if the block is missing or occurs multiple times.', {
  type: 'object',
  properties: {
    path: { type: 'string', description: 'Path to the file to edit under /workspace.' },
    target: { type: 'string', description: 'The exact block of text to be replaced (including leading whitespace/newlines).' },
    replacement: { type: 'string', description: 'The replacement text.' },
  },
  required: ['path', 'target', 'replacement'],
})

// ─── Internal message protocol ───

export type BashToolMsg =
  | ToolInvokeMsg
  | { type: '_bashDone'; result: BashExecResult; replyTo: ActorRef<ToolReply>; span: SpanHandle | null }
  | { type: '_bashErr'; error: string; replyTo: ActorRef<ToolReply>; span: SpanHandle | null }
  | { type: '_writeDone'; path: string; replyTo: ActorRef<ToolReply>; span: SpanHandle | null }
  | { type: '_writeErr'; error: string; replyTo: ActorRef<ToolReply>; span: SpanHandle | null }
  | { type: '_readDone'; content: string; replyTo: ActorRef<ToolReply>; span: SpanHandle | null }
  | { type: '_readErr'; error: string; replyTo: ActorRef<ToolReply>; span: SpanHandle | null }
  | { type: '_editReadDone'; path: string; target: string; replacement: string; content: string; replyTo: ActorRef<ToolReply>; span: SpanHandle | null }
  | { type: '_editWriteDone'; path: string; replyTo: ActorRef<ToolReply>; span: SpanHandle | null }

// ─── Result formatting ───

const formatExecResult = (result: BashExecResult): string => {
  const parts: string[] = []
  if (result.stdout) parts.push(result.stdout)
  if (result.stderr) parts.push(`STDERR:\n${result.stderr}`)
  if (result.exitCode !== 0) parts.push(`Exit code: ${result.exitCode}`)
  return parts.join('\n') || '(no output)'
}

// ─── Actor definition ───

export const BashTool = (options?: BashOptions): ActorDef<BashToolMsg, null> => {
  const fs = new MountableFs({ base: new InMemoryFs() });

  // Mount read-only knowledge base
  fs.mount("/rorschach", new OverlayFs({ root: "/home/rigel/rorschach/src", readOnly: true }));
  // Mount read-write workspace
  fs.mount("/workspace", new ReadWriteFs({ root: "/home/rigel/rorschach/workspace" }));

  const bash = new Bash({ fs, cwd: options?.cwd })

  return {
    initialState: null,
    handler: onMessage<BashToolMsg, null>({
      invoke: (state, message, ctx) => {
        const { toolName, arguments: rawArgs, replyTo } = message

        const parent = ctx.trace.fromHeaders()

        if (toolName === bashTool.name) {
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
        } else if (toolName === writeTool.name) {
          const args = JSON.parse(rawArgs) as { path: string; content: string }

          ctx.log.info('bash write', { path: args.path })
          const span: SpanHandle | null = parent
            ? ctx.trace.child(parent.traceId, parent.spanId, toolName, { toolName, path: args.path })
            : null

          ctx.pipeToSelf(
            fs.writeFile(args.path, args.content),
            () => ({ type: '_writeDone' as const, path: args.path, replyTo, span }),
            (error) => ({ type: '_writeErr' as const, error: String(error), replyTo, span }),
          )
        } else if (toolName === readTool.name) {
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
        } else if (toolName === editTool.name) {
          const args = JSON.parse(rawArgs) as { path: string; target: string; replacement: string }

          // Ensure safety check: path must be under /workspace
          if (args.path !== '/workspace' && !args.path.startsWith('/workspace/')) {
            replyTo.send({ type: 'toolError', error: 'Permission denied: edit target path must reside inside /workspace' })
            return { state }
          }

          ctx.log.info('bash edit read', { path: args.path })
          const span: SpanHandle | null = parent
            ? ctx.trace.child(parent.traceId, parent.spanId, toolName, { toolName, path: args.path })
            : null

          ctx.pipeToSelf(
            fs.readFile(args.path),
            (content) => ({
              type: '_editReadDone' as const,
              path: args.path,
              target: args.target,
              replacement: args.replacement,
              content,
              replyTo,
              span,
            }),
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
        replyTo.send({ type: 'toolResult', result: { text: formatExecResult(result) } })
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
        replyTo.send({ type: 'toolResult', result: { text: `Written ${path}` } })
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
        replyTo.send({ type: 'toolResult', result: { text: content } })
        return { state }
      },

      _readErr: (state, message, ctx) => {
        const { error, replyTo, span } = message
        ctx.log.error('bash read failed', { error })
        span?.error(error)
        replyTo.send({ type: 'toolError', error })
        return { state }
      },

      _editReadDone: (state, message, ctx) => {
        const { path, target, replacement, content, replyTo, span } = message

        // 1. Verify occurrences of target block in the file
        const occurrences = content.split(target).length - 1

        if (occurrences === 0) {
          ctx.log.error('edit target not found', { path })
          span?.error('Target text block not found in the file')
          replyTo.send({ type: 'toolError', error: 'Target text block not found in the file' })
          return { state }
        }

        if (occurrences > 1) {
          ctx.log.error('edit target not unique', { path, occurrences })
          span?.error(`Target text block is not unique: found ${occurrences} occurrences`)
          replyTo.send({ type: 'toolError', error: `Target text block is not unique: found ${occurrences} occurrences. Please provide a more unique target block.` })
          return { state }
        }

        // 2. Perform the unique replacement
        const updatedContent = content.replace(target, replacement)

        // 3. Write back the updated content
        ctx.log.info('bash edit write', { path })
        ctx.pipeToSelf(
          fs.writeFile(path, updatedContent),
          () => ({ type: '_editWriteDone' as const, path, replyTo, span }),
          (error) => ({ type: '_writeErr' as const, error: String(error), replyTo, span }),
        )

        return { state }
      },

      _editWriteDone: (state, message) => {
        const { path, replyTo, span } = message
        span?.done({ path })
        replyTo.send({ type: 'toolResult', result: { text: `Successfully updated ${path}` } })
        return { state }
      },
    }),

    supervision: { type: 'restart', maxRetries: 3, withinMs: 30_000 },
  }
}
