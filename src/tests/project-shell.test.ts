import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AgentSystem, ask, type ActorRef } from '../system/index.ts'
import {
  ProjectShell,
  codingBashTool,
  codingReadTool,
  codingGrepTool,
  codingGlobTool,
  codingWriteTool,
  codingStrReplaceTool,
  truncateForAgent,
  normalizeVirtualPath,
  isAllowedMountPath,
  sliceLineWindow,
  formatReadResult,
  formatNumberedLine,
  numberLineWindowBody,
  matchGlob,
  assertWorkspaceWritePath,
  compileSearchRegex,
  countOccurrences,
  lineNumberAtIndex,
  MAX_TOOL_RESULT_CHARS,
  DEFAULT_READ_LINE_LIMIT,
  MAX_WRITE_CHARS,
} from '../plugins/coding/project-shell.ts'
import type { SCRInvokeMsg, SCRReply } from '../types/scr.ts'
import { HttpWsFrameTopic, OutboundUserMessageTopic } from '../types/events.ts'

const tick = (ms = 50) => Bun.sleep(ms)

const askShell = async (
  ref: ActorRef<any>,
  toolName: string,
  args: Record<string, unknown>,
  opts: { timeoutMs?: number; userId?: string } = {},
): Promise<SCRReply> => {
  return ask<SCRInvokeMsg, SCRReply>(
    ref,
    replyTo => ({
      type: 'invoke',
      urn: `scr:leaf:coding.${toolName.replace(/^coding_/, '')}`,
      input: args,
      replyTo,
    }),
    opts,
  )
}

describe('project-shell helpers', () => {
  test('truncateForAgent leaves short text alone', () => {
    expect(truncateForAgent('hello', 100)).toBe('hello')
  })

  test('truncateForAgent appends remainder marker', () => {
    const out = truncateForAgent('abcdefghij', 5)
    expect(out.startsWith('abcde')).toBe(true)
    expect(out).toContain('truncated 5 chars')
  })

  test('normalizeVirtualPath collapses dots and rejects escape', () => {
    expect(normalizeVirtualPath('/rorschach/a/../b')).toBe('/rorschach/b')
    expect(normalizeVirtualPath('/rorschach/./x')).toBe('/rorschach/x')
    expect(normalizeVirtualPath('relative')).toBeNull()
    expect(normalizeVirtualPath('/../etc')).toBeNull()
  })

  test('isAllowedMountPath accepts project and workspace only', () => {
    expect(isAllowedMountPath('/rorschach', '/rorschach')).toBe(true)
    expect(isAllowedMountPath('/rorschach/plugins', '/rorschach')).toBe(true)
    expect(isAllowedMountPath('/workspace/out.txt', '/rorschach')).toBe(true)
    expect(isAllowedMountPath('/etc/passwd', '/rorschach')).toBe(false)
    expect(isAllowedMountPath('/rorschach-evil', '/rorschach')).toBe(false)
  })

  test('sliceLineWindow pages by 1-based offset/limit', () => {
    const content = ['a', 'b', 'c', 'd', 'e'].join('\n')
    const win = sliceLineWindow(content, 2, 2)
    expect(win.body).toBe('b\nc')
    expect(win.startLine).toBe(2)
    expect(win.endLine).toBe(3)
    expect(win.totalLines).toBe(5)
    expect(win.truncatedByLines).toBe(true)
  })

  test('formatReadResult includes path metadata, LINE| prefixes, and continue hint', () => {
    const lines = Array.from({ length: 10 }, (_, i) => `L${i + 1}`).join('\n')
    const text = formatReadResult('/rorschach/f.ts', lines, 1, 3)
    expect(text).toContain('// path: /rorschach/f.ts')
    expect(text).toContain('lines 1-3 of 10')
    expect(text).toContain('1|L1')
    expect(text).toContain('3|L3')
    expect(text).not.toContain('4|L4')
    expect(text).toContain('offset=4')
  })

  test('formatReadResult uses absolute line numbers for mid-file windows', () => {
    const content = ['a', 'b', 'c', 'd', 'e'].join('\n')
    const text = formatReadResult('/rorschach/x.ts', content, 2, 2)
    expect(text).toContain('lines 2-3 of 5')
    expect(text).toContain('2|b')
    expect(text).toContain('3|c')
    expect(text).not.toContain('1|a')
    expect(text).toContain('offset=4')
  })

  test('formatNumberedLine pads to width', () => {
    expect(formatNumberedLine(7, 'hi', 3)).toBe('  7|hi')
    expect(numberLineWindowBody('x\ny', 99, 100)).toBe(' 99|x\n100|y')
  })

  test('formatReadResult empty file has no numbered body', () => {
    const text = formatReadResult('/rorschach/empty.ts', '')
    expect(text).toContain('// empty file')
    expect(text).not.toMatch(/^\s*\d+\|/m)
  })

  test('countOccurrences is non-overlapping left-to-right', () => {
    expect(countOccurrences('aaaa', 'aa')).toBe(2)
    expect(countOccurrences('ababab', 'ab')).toBe(3)
    expect(countOccurrences('hello', 'x')).toBe(0)
    expect(countOccurrences('hello', '')).toBe(0)
  })

  test('lineNumberAtIndex maps byte index to 1-based line', () => {
    const content = 'a\nb\nc'
    expect(lineNumberAtIndex(content, 0)).toBe(1)
    expect(lineNumberAtIndex(content, 2)).toBe(2)
    expect(lineNumberAtIndex(content, 4)).toBe(3)
  })

  test('matchGlob supports *, ?, and **', () => {
    expect(matchGlob('**/*.ts', 'plugins/coding/a.ts')).toBe(true)
    expect(matchGlob('**/*.ts', 'a.ts')).toBe(true)
    expect(matchGlob('**/*.ts', 'a.js')).toBe(false)
    expect(matchGlob('*.ts', 'a.ts')).toBe(true)
    expect(matchGlob('*.ts', 'nested/a.ts')).toBe(false)
    expect(matchGlob('foo/*/bar', 'foo/x/bar')).toBe(true)
    expect(matchGlob('foo/*/bar', 'foo/x/y/bar')).toBe(false)
    expect(matchGlob('a/**/b', 'a/b')).toBe(true)
    expect(matchGlob('a/**/b', 'a/x/y/b')).toBe(true)
    expect(matchGlob('?.ts', 'a.ts')).toBe(true)
    expect(matchGlob('?.ts', 'ab.ts')).toBe(false)
  })

  test('assertWorkspaceWritePath only allows /workspace files', () => {
    expect(assertWorkspaceWritePath('/workspace/a.txt').ok).toBe(true)
    expect(assertWorkspaceWritePath('/workspace').ok).toBe(false)
    expect(assertWorkspaceWritePath('/rorschach/a.ts').ok).toBe(false)
    expect(assertWorkspaceWritePath('/etc/passwd').ok).toBe(false)
  })

  test('compileSearchRegex rejects invalid patterns', () => {
    expect(compileSearchRegex('foo(').ok).toBe(false)
    expect(compileSearchRegex('hello').ok).toBe(true)
  })
})

describe('ProjectShell actor tools', () => {
  const root = join(tmpdir(), `rorschach-project-shell-${process.pid}`)
  const projectRoot = join(root, 'src')
  const workspaceDir = join(root, 'workspace')

  beforeAll(() => {
    rmSync(root, { recursive: true, force: true })
    mkdirSync(projectRoot, { recursive: true })
    mkdirSync(join(projectRoot, 'nested'), { recursive: true })
    mkdirSync(join(projectRoot, 'node_modules', 'pkg'), { recursive: true })
    mkdirSync(workspaceDir, { recursive: true })

    const manyLines = Array.from({ length: 50 }, (_, i) => `line-${i + 1}`).join('\n')
    writeFileSync(join(projectRoot, 'sample.ts'), manyLines)
    writeFileSync(join(projectRoot, 'hello.txt'), 'hello from project\nunique-coding_file_grep-token-alpha\n')
    writeFileSync(join(projectRoot, 'nested', 'deep.ts'), 'export const deep = "unique-coding_file_grep-token-alpha"\n')
    writeFileSync(join(projectRoot, 'nested', 'other.md'), '# docs\n')
    writeFileSync(join(projectRoot, 'node_modules', 'pkg', 'secret.ts'), 'unique-coding_file_grep-token-alpha should be skipped\n')
    writeFileSync(join(projectRoot, 'binary.bin'), Buffer.from([0x00, 0x01, 0x02, 0x68, 0x69]))
    writeFileSync(join(workspaceDir, 'note.txt'), 'workspace note\n')
  })

  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
  })

  const spawnShell = async () => {
    const system = await AgentSystem()
    const ref = system.spawn(
      'project-shell-test',
      ProjectShell({
        projectRoot,
        projectMount: '/rorschach',
        workspaceDir,
      }),
    )
    await tick()
    return { system, ref }
  }

  test('coding_shell_exec runs with default cwd under project mount', async () => {
    const { system, ref } = await spawnShell()

    const reply = await askShell(ref, codingBashTool.name, { command: 'pwd' }, { timeoutMs: 2000, userId: 'test-user' })

    expect(reply.type).toBe('result')
    if (reply.type === 'result') {
      const text = (reply.output as { text: string }).text
      expect(text).toContain('/rorschach')
      expect(text).toContain('cwd:')
    }

    await system.shutdown()
  })

  test('coding_shell_exec respects explicit cwd under /workspace', async () => {
    const { system, ref } = await spawnShell()

    const reply = await askShell(ref, codingBashTool.name, { command: 'pwd && cat note.txt', cwd: '/workspace' }, { timeoutMs: 2000, userId: 'test-user' })

    expect(reply.type).toBe('result')
    if (reply.type === 'result') {
      const text = (reply.output as { text: string }).text
      expect(text).toContain('/workspace')
      expect(text).toContain('workspace note')
    }

    await system.shutdown()
  })

  test('coding_shell_exec rejects cwd outside mounts', async () => {
    const { system, ref } = await spawnShell()

    const reply = await askShell(ref, codingBashTool.name, { command: 'pwd', cwd: '/etc' }, { timeoutMs: 2000, userId: 'test-user' })

    expect(reply.type).toBe('error')
    if (reply.type === 'error') {
      expect(reply.error).toContain('cwd must be under')
    }

    await system.shutdown()
  })

  test('agent coding_shell_exec session cwd sticks across calls without explicit cwd', async () => {
    const { system, ref } = await spawnShell()

    const cd = await askShell(ref, codingBashTool.name, { command: 'cd /workspace && pwd' }, { timeoutMs: 2000, userId: 'test-user' })
    expect(cd.type).toBe('result')
    if (cd.type === 'result') {
      expect((cd.output as { text: string }).text).toContain('/workspace')
    }

    const next = await askShell(ref, codingBashTool.name, { command: 'pwd && cat note.txt' }, { timeoutMs: 2000, userId: 'test-user' })
    expect(next.type).toBe('result')
    if (next.type === 'result') {
      const text = (next.output as { text: string }).text
      expect(text).toContain('/workspace')
      expect(text).toContain('workspace note')
      expect(text).not.toMatch(/cwd: \/rorschach\b/)
    }

    await system.shutdown()
  })

  test('agent coding_shell_exec cwd is independent of UI terminal cwd', async () => {
    const { system, ref } = await spawnShell()
    await tick(100)

    const outbound: Array<{ userId: string; text: string }> = []
    system.subscribe(OutboundUserMessageTopic, event => {
      outbound.push(event)
    })

    // Move UI session into /workspace via websocket coding_shell_exec frame.
    system.publish(HttpWsFrameTopic, {
      clientId: 'c1',
      userId: 'ui-user',
      roles: [],
      frame: {
        type: 'coding.bash.command',
        cmdId: 'ui-cd-1',
        command: 'cd /workspace && pwd',
        cwd: '/rorschach',
      },
    })

    const start = Date.now()
    while (outbound.length < 1 && Date.now() - start < 2000) {
      await tick(20)
    }
    expect(outbound.length).toBeGreaterThanOrEqual(1)
    const uiReply = JSON.parse(outbound[outbound.length - 1]!.text) as {
      type: string
      cwd?: string
      exitCode?: number
    }
    expect(uiReply.type).toBe('coding.bash.response')
    expect(uiReply.cwd).toBe('/workspace')

    // Agent coding_shell_exec should still default to project mount, not UI cwd.
    const agent = await askShell(ref, codingBashTool.name, { command: 'pwd' }, { timeoutMs: 2000, userId: 'agent-user' })
    expect(agent.type).toBe('result')
    if (agent.type === 'result') {
      const text = (agent.output as { text: string }).text
      expect(text).toContain('/rorschach')
      expect(text).toMatch(/cwd: \/rorschach\b/)
    }

    // Move agent cwd; UI should remain at /workspace on next UI command that omits a new cwd.
    const agentCd = await askShell(ref, codingBashTool.name, { command: 'cd /workspace && pwd' }, { timeoutMs: 2000, userId: 'agent-user' })
    expect(agentCd.type).toBe('result')

    outbound.length = 0
    // UI frame with no cwd falls back to uiCwd (still /workspace from first UI command).
    system.publish(HttpWsFrameTopic, {
      clientId: 'c1',
      userId: 'ui-user',
      roles: [],
      frame: {
        type: 'coding.bash.command',
        cmdId: 'ui-pwd-2',
        command: 'pwd',
      },
    })
    const start2 = Date.now()
    while (outbound.length < 1 && Date.now() - start2 < 2000) {
      await tick(20)
    }
    expect(outbound.length).toBeGreaterThanOrEqual(1)
    const uiPwd = JSON.parse(outbound[outbound.length - 1]!.text) as { cwd?: string; stdout?: string }
    expect(uiPwd.cwd).toBe('/workspace')
    expect(uiPwd.stdout ?? '').toContain('/workspace')

    await system.shutdown()
  })

  test('coding_file_read returns a line window via fs, not full dump by default', async () => {
    const { system, ref } = await spawnShell()

    const reply = await askShell(ref, codingReadTool.name, { path: '/rorschach/sample.ts', offset: 1, limit: 5 }, { timeoutMs: 2000, userId: 'test-user' })

    expect(reply.type).toBe('result')
    if (reply.type === 'result') {
      const text = (reply.output as { text: string }).text
      expect(text).toContain('// path: /rorschach/sample.ts')
      expect(text).toContain('lines 1-5 of 50')
      expect(text).toContain('1|line-1')
      expect(text).toContain('5|line-5')
      expect(text).not.toContain('6|line-6')
      expect(text).toContain('offset=6')
    }

    await system.shutdown()
  })

  test('coding_file_read rejects paths outside mounts', async () => {
    const { system, ref } = await spawnShell()

    const reply = await askShell(ref, codingReadTool.name, { path: '/etc/passwd' }, { timeoutMs: 2000, userId: 'test-user' })

    expect(reply.type).toBe('error')
    if (reply.type === 'error') {
      expect(reply.error).toContain('Path must be under')
    }

    await system.shutdown()
  })

  test('coding_file_read rejects path traversal out of mounts', async () => {
    const { system, ref } = await spawnShell()

    const reply = await askShell(ref, codingReadTool.name, { path: '/rorschach/../../etc/passwd' }, { timeoutMs: 2000, userId: 'test-user' })

    expect(reply.type).toBe('error')

    await system.shutdown()
  })

  test('project tree is coding_file_read-only; workspace is writable', async () => {
    const { system, ref } = await spawnShell()

    const ro = await askShell(ref, codingBashTool.name, { command: 'echo no > /rorschach/should-fail.txt' }, { timeoutMs: 2000, userId: 'test-user' })
    // OverlayFs may reject via non-zero exit or by throwing into error.
    if (ro.type === 'result') {
      expect((ro.output as { text: string }).text).toMatch(/Exit code:|STDERR:|Read-only|coding_file_read-only|EROFS|denied|EPERM/i)
    } else if (ro.type === 'error') {
      expect(ro.error).toMatch(/coding_file_read-only|Read-only|EROFS|EPERM|denied|EACCES|not permitted|writable/i)
    } else {
      throw new Error(`unexpected reply type: ${ro.type}`)
    }

    const rw = await askShell(ref, codingBashTool.name, { command: 'echo ok > /workspace/agent-coding_file_write.txt && cat /workspace/agent-coding_file_write.txt' }, { timeoutMs: 2000, userId: 'test-user' })
    expect(rw.type).toBe('result')
    if (rw.type === 'result') {
      const text = (rw.output as { text: string }).text
      expect(text).toContain('ok')
      expect(text).not.toMatch(/Exit code: [1-9]/)
    }

    await system.shutdown()
  })

  test('agent-facing coding_shell_exec output is truncated past MAX_TOOL_RESULT_CHARS', async () => {
    const { system, ref } = await spawnShell()

    // Generate more than the agent soft cap via a compact shell loop.
    const reply = await askShell(
      ref,
      codingBashTool.name,
      { command: `python3 -c "print('x'*${MAX_TOOL_RESULT_CHARS + 5000})" 2>/dev/null || awk 'BEGIN{for(i=0;i<${MAX_TOOL_RESULT_CHARS + 5000};i++)printf "x"}'` },
      { timeoutMs: 5000, userId: 'test-user' },
    )

    expect(reply.type).toBe('result')
    if (reply.type === 'result') {
      const text = (reply.output as { text: string }).text
      expect(text.length).toBeLessThanOrEqual(MAX_TOOL_RESULT_CHARS + 80)
      // Either our soft truncate marker or sandbox max-output behavior.
      const truncated =
        text.includes('truncated') ||
        text.length <= MAX_TOOL_RESULT_CHARS + 80
      expect(truncated).toBe(true)
    }

    await system.shutdown()
  })

  test('default coding_file_read limit constant is wired into tool description', () => {
    const params = codingReadTool.schema.function.parameters as {
      properties: { limit: { description: string } }
    }
    expect(params.properties.limit.description).toContain(String(DEFAULT_READ_LINE_LIMIT))
  })

  test('coding_file_glob finds paths by pattern under project mount', async () => {
    const { system, ref } = await spawnShell()

    const reply = await askShell(ref, codingGlobTool.name, { pattern: '**/*.ts' }, { timeoutMs: 3000, userId: 'test-user' })

    expect(reply.type).toBe('result')
    if (reply.type === 'result') {
      const text = (reply.output as { text: string }).text
      expect(text).toContain('/rorschach/sample.ts')
      expect(text).toContain('/rorschach/nested/deep.ts')
      expect(text).not.toContain('node_modules')
      expect(text).toContain('// results:')
    }

    await system.shutdown()
  })

  test('coding_file_glob rejects path outside mounts', async () => {
    const { system, ref } = await spawnShell()

    const reply = await askShell(ref, codingGlobTool.name, { pattern: '**/*', path: '/etc' }, { timeoutMs: 2000, userId: 'test-user' })

    expect(reply.type).toBe('error')

    await system.shutdown()
  })

  test('coding_file_glob truncates at maxResults', async () => {
    const { system, ref } = await spawnShell()

    const reply = await askShell(ref, codingGlobTool.name, { pattern: '**/*', maxResults: 1 }, { timeoutMs: 3000, userId: 'test-user' })

    expect(reply.type).toBe('result')
    if (reply.type === 'result') {
      const text = (reply.output as { text: string }).text
      expect(text).toContain('// results: 1')
      expect(text).toContain('truncated at maxResults')
    }

    await system.shutdown()
  })

  test('coding_file_grep finds content with line numbers', async () => {
    const { system, ref } = await spawnShell()

    const reply = await askShell(ref, codingGrepTool.name, { pattern: 'unique-coding_file_grep-token-alpha' }, { timeoutMs: 3000, userId: 'test-user' })

    expect(reply.type).toBe('result')
    if (reply.type === 'result') {
      const text = (reply.output as { text: string }).text
      expect(text).toContain('/rorschach/hello.txt:2:')
      expect(text).toContain('/rorschach/nested/deep.ts:1:')
      expect(text).not.toContain('node_modules')
      expect(text).toContain('// matches:')
    }

    await system.shutdown()
  })

  test('coding_file_grep respects coding_file_glob filter', async () => {
    const { system, ref } = await spawnShell()

    const reply = await askShell(ref, codingGrepTool.name, { pattern: 'unique-coding_file_grep-token-alpha', glob: '*.ts' }, { timeoutMs: 3000, userId: 'test-user' })

    expect(reply.type).toBe('result')
    if (reply.type === 'result') {
      const text = (reply.output as { text: string }).text
      expect(text).toContain('deep.ts')
      expect(text).not.toContain('hello.txt')
    }

    await system.shutdown()
  })

  test('coding_file_grep rejects invalid regex', async () => {
    const { system, ref } = await spawnShell()

    const reply = await askShell(ref, codingGrepTool.name, { pattern: 'foo(' }, { timeoutMs: 2000, userId: 'test-user' })

    expect(reply.type).toBe('error')
    if (reply.type === 'error') {
      expect(reply.error).toMatch(/Invalid regex|regex/i)
    }

    await system.shutdown()
  })

  test('coding_file_grep truncates at maxMatches', async () => {
    const { system, ref } = await spawnShell()

    const reply = await askShell(ref, codingGrepTool.name, { pattern: 'line-', path: '/rorschach/sample.ts', maxMatches: 3 }, { timeoutMs: 3000, userId: 'test-user' })

    expect(reply.type).toBe('result')
    if (reply.type === 'result') {
      const text = (reply.output as { text: string }).text
      expect(text).toContain('// matches: 3')
      expect(text).toContain('truncated at maxMatches')
    }

    await system.shutdown()
  })

  test('coding_file_write creates file under workspace and can be coding_file_read back', async () => {
    const { system, ref } = await spawnShell()

    const writeReply = await askShell(ref, codingWriteTool.name, {
      path: '/workspace/drafts/out.txt',
      content: 'hello workspace coding_file_write\n',
    }, { timeoutMs: 2000, userId: 'test-user' })

    expect(writeReply.type).toBe('result')
    if (writeReply.type === 'result') {
      const text = (writeReply.output as { text: string }).text
      expect(text).toContain('/workspace/drafts/out.txt')
      expect(text).toMatch(/Wrote|Overwrote/)
    }

    const readReply = await askShell(ref, codingReadTool.name, { path: '/workspace/drafts/out.txt' }, { timeoutMs: 2000, userId: 'test-user' })

    expect(readReply.type).toBe('result')
    if (readReply.type === 'result') {
      const text = (readReply.output as { text: string }).text
      expect(text).toContain('hello workspace coding_file_write')
    }

    await system.shutdown()
  })

  test('coding_file_write rejects project mount paths', async () => {
    const { system, ref } = await spawnShell()

    const reply = await askShell(ref, codingWriteTool.name, {
      path: '/rorschach/nope.ts',
      content: 'nope',
    }, { timeoutMs: 2000, userId: 'test-user' })

    expect(reply.type).toBe('error')
    if (reply.type === 'error') {
      expect(reply.error).toMatch(/read-only|workspace/i)
    }

    await system.shutdown()
  })

  test('coding_file_write rejects oversized content', async () => {
    const { system, ref } = await spawnShell()

    const reply = await askShell(ref, codingWriteTool.name, {
      path: '/workspace/big.txt',
      content: 'x'.repeat(MAX_WRITE_CHARS + 1),
    }, { timeoutMs: 2000, userId: 'test-user' })

    expect(reply.type).toBe('error')
    if (reply.type === 'error') {
      expect(reply.error).toContain('too large')
    }

    await system.shutdown()
  })

  test('coding_file_replace_string unique match updates workspace file and can be coding_file_read back', async () => {
    const { system, ref } = await spawnShell()

    await askShell(ref, codingWriteTool.name, {
      path: '/workspace/edit-me.ts',
      content: 'const a = 1\nconst b = 2\n',
    }, { timeoutMs: 2000, userId: 'test-user' })

    const replace = await askShell(ref, codingStrReplaceTool.name, {
      path: '/workspace/edit-me.ts',
      old_string: 'const b = 2',
      new_string: 'const b = 3',
    }, { timeoutMs: 2000, userId: 'test-user' })

    expect(replace.type).toBe('result')
    if (replace.type === 'result') {
      const text = (replace.output as { text: string }).text
      expect(text).toMatch(/Replaced 1 occurrence/)
      expect(text).toContain('/workspace/edit-me.ts')
      expect(text).toContain('line 2')
    }

    const readBack = await askShell(ref, codingReadTool.name, { path: '/workspace/edit-me.ts' }, { timeoutMs: 2000, userId: 'test-user' })
    expect(readBack.type).toBe('result')
    if (readBack.type === 'result') {
      const text = (readBack.output as { text: string }).text
      expect(text).toContain('2|const b = 3')
      expect(text).not.toContain('const b = 2')
    }

    await system.shutdown()
  })

  test('coding_file_replace_string rejects non-unique match unless replace_all', async () => {
    const { system, ref } = await spawnShell()

    await askShell(ref, codingWriteTool.name, {
      path: '/workspace/dup.txt',
      content: 'foo\nbar\nfoo\n',
    }, { timeoutMs: 2000, userId: 'test-user' })

    const ambiguous = await askShell(ref, codingStrReplaceTool.name, {
      path: '/workspace/dup.txt',
      old_string: 'foo',
      new_string: 'baz',
    }, { timeoutMs: 2000, userId: 'test-user' })
    expect(ambiguous.type).toBe('error')
    if (ambiguous.type === 'error') {
      expect(ambiguous.error).toMatch(/2 times|unique|replace_all/i)
    }

    const all = await askShell(ref, codingStrReplaceTool.name, {
      path: '/workspace/dup.txt',
      old_string: 'foo',
      new_string: 'baz',
      replace_all: true,
    }, { timeoutMs: 2000, userId: 'test-user' })
    expect(all.type).toBe('result')
    if (all.type === 'result') {
      expect((all.output as { text: string }).text).toMatch(/Replaced 2 occurrence/)
    }

    await system.shutdown()
  })

  test('coding_file_replace_string rejects missing file, not found, project path, and identical strings', async () => {
    const { system, ref } = await spawnShell()

    const missing = await askShell(ref, codingStrReplaceTool.name, {
      path: '/workspace/no-such.txt',
      old_string: 'a',
      new_string: 'b',
    }, { timeoutMs: 2000, userId: 'test-user' })
    expect(missing.type).toBe('error')
    if (missing.type === 'error') {
      expect(missing.error).toMatch(/not found/i)
    }

    await askShell(ref, codingWriteTool.name, {
      path: '/workspace/once.txt',
      content: 'hello world\n',
    }, { timeoutMs: 2000, userId: 'test-user' })

    const notFound = await askShell(ref, codingStrReplaceTool.name, {
      path: '/workspace/once.txt',
      old_string: 'missing-token',
      new_string: 'x',
    }, { timeoutMs: 2000, userId: 'test-user' })
    expect(notFound.type).toBe('error')
    if (notFound.type === 'error') {
      expect(notFound.error).toMatch(/not found/i)
    }

    const ro = await askShell(ref, codingStrReplaceTool.name, {
      path: '/rorschach/sample.ts',
      old_string: 'line-1',
      new_string: 'nope',
    }, { timeoutMs: 2000, userId: 'test-user' })
    expect(ro.type).toBe('error')
    if (ro.type === 'error') {
      expect(ro.error).toMatch(/read-only|workspace/i)
    }

    const same = await askShell(ref, codingStrReplaceTool.name, {
      path: '/workspace/once.txt',
      old_string: 'hello',
      new_string: 'hello',
    }, { timeoutMs: 2000, userId: 'test-user' })
    expect(same.type).toBe('error')
    if (same.type === 'error') {
      expect(same.error).toMatch(/identical|no change/i)
    }

    await system.shutdown()
  })
})
