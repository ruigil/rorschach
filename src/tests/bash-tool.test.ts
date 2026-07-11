import { describe, test, expect } from 'bun:test'
import { AgentSystem, ask } from '../system/index.ts'
import { BashTool } from '../plugins/tools/bash.ts'
import type { ToolInvokeMsg, ToolReply } from '../types/tools.ts'

const tick = (ms = 50) => Bun.sleep(ms)

describe('BashTool Actor', () => {
  test('executes basic bash commands with stdout and exitCode 0', async () => {
    const system = await AgentSystem()
    const ref = system.spawn('bash-test-1', BashTool())
    await tick()

    const reply = await ask<ToolInvokeMsg, ToolReply>(
      ref,
      (replyTo) => ({
        type: 'invoke',
        toolName: 'bash',
        arguments: JSON.stringify({ command: 'echo "Hello World"' }),
        replyTo,
        userId: 'test-user',
      }),
      { timeoutMs: 1000 },
    )

    expect(reply.type).toBe('toolResult')
    if (reply.type === 'toolResult') {
      expect(reply.result.text.trim()).toBe('Hello World')
    }

    await system.shutdown()
  })

  test('executes command using raw string argument format', async () => {
    const system = await AgentSystem()
    const ref = system.spawn('bash-test-2', BashTool())
    await tick()

    const reply = await ask<ToolInvokeMsg, ToolReply>(
      ref,
      (replyTo) => ({
        type: 'invoke',
        toolName: 'bash',
        arguments: 'echo "Raw Command Test"',
        replyTo,
        userId: 'test-user',
      }),
      { timeoutMs: 1000 },
    )

    expect(reply.type).toBe('toolResult')
    if (reply.type === 'toolResult') {
      expect(reply.result.text.trim()).toBe('Raw Command Test')
    }

    await system.shutdown()
  })

  test('captures exit code and stderr on failure', async () => {
    const system = await AgentSystem()
    const ref = system.spawn('bash-test-3', BashTool())
    await tick()

    const reply = await ask<ToolInvokeMsg, ToolReply>(
      ref,
      (replyTo) => ({
        type: 'invoke',
        toolName: 'bash',
        arguments: JSON.stringify({ command: 'ls /nonexistent_directory_abc_123' }),
        replyTo,
        userId: 'test-user',
      }),
      { timeoutMs: 1000 },
    )

    expect(reply.type).toBe('toolResult')
    if (reply.type === 'toolResult') {
      expect(reply.result.text).toContain('Exit code:')
      expect(reply.result.text).toContain('STDERR:')
    }

    await system.shutdown()
  })

  test('lists files in the read-only /rorschach knowledge base mount', async () => {
    const system = await AgentSystem()
    const ref = system.spawn('bash-test-rorschach', BashTool())
    await tick()

    // 1. Verify listing the virtual root contains 'home'
    const replyRoot = await ask<ToolInvokeMsg, ToolReply>(
      ref,
      (replyTo) => ({
        type: 'invoke',
        toolName: 'bash',
        arguments: JSON.stringify({ command: 'ls /rorschach' }),
        replyTo,
        userId: 'test-user',
      }),
      { timeoutMs: 1000 },
    )

    expect(replyRoot.type).toBe('toolResult')
    if (replyRoot.type === 'toolResult') {
      expect(replyRoot.result.text).toContain('home')
    }

    // 2. Verify listing the mounted project directory contains the actual source folders
    const replyProj = await ask<ToolInvokeMsg, ToolReply>(
      ref,
      (replyTo) => ({
        type: 'invoke',
        toolName: 'bash',
        arguments: JSON.stringify({ command: 'ls /rorschach/home/user/project' }),
        replyTo,
        userId: 'test-user',
      }),
      { timeoutMs: 1000 },
    )

    expect(replyProj.type).toBe('toolResult')
    if (replyProj.type === 'toolResult') {
      expect(replyProj.result.text).toContain('plugins')
      expect(replyProj.result.text).toContain('system')
    }

    await system.shutdown()
  })

  test('supports stdin parameter', async () => {
    const system = await AgentSystem()
    const ref = system.spawn('bash-test-4', BashTool())
    await tick()

    const reply = await ask<ToolInvokeMsg, ToolReply>(
      ref,
      (replyTo) => ({
        type: 'invoke',
        toolName: 'bash',
        arguments: JSON.stringify({ command: 'cat', stdin: 'piped content' }),
        replyTo,
        userId: 'test-user',
      }),
      { timeoutMs: 1000 },
    )

    expect(reply.type).toBe('toolResult')
    if (reply.type === 'toolResult') {
      expect(reply.result.text).toBe('piped content')
    }

    await system.shutdown()
  })

  test('performs write, read, and edit tool operations successfully', async () => {
    const system = await AgentSystem()
    const ref = system.spawn('bash-test-5', BashTool())
    await tick()

    const testFilePath = '/workspace/test_file.txt'
    const initialContent = 'This is line one.\nThis is the target line.\nThis is line three.'

    // 1. Write initial content to file
    const writeReply = await ask<ToolInvokeMsg, ToolReply>(
      ref,
      (replyTo) => ({
        type: 'invoke',
        toolName: 'write',
        arguments: JSON.stringify({ path: testFilePath, content: initialContent }),
        replyTo,
        userId: 'test-user',
      }),
      { timeoutMs: 1000 },
    )

    expect(writeReply.type).toBe('toolResult')
    if (writeReply.type === 'toolResult') {
      expect(writeReply.result.text).toContain('Written')
      expect(writeReply.result.text).toContain(testFilePath)
    }

    // 2. Read back written content
    const readReply = await ask<ToolInvokeMsg, ToolReply>(
      ref,
      (replyTo) => ({
        type: 'invoke',
        toolName: 'read',
        arguments: JSON.stringify({ path: testFilePath }),
        replyTo,
        userId: 'test-user',
      }),
      { timeoutMs: 1000 },
    )

    expect(readReply.type).toBe('toolResult')
    if (readReply.type === 'toolResult') {
      expect(readReply.result.text).toBe(initialContent)
    }

    // 3. Edit content (unique target replacement)
    const targetText = 'This is the target line.'
    const replacementText = 'This is the replaced line.'
    const editReply = await ask<ToolInvokeMsg, ToolReply>(
      ref,
      (replyTo) => ({
        type: 'invoke',
        toolName: 'edit',
        arguments: JSON.stringify({
          path: testFilePath,
          target: targetText,
          replacement: replacementText,
        }),
        replyTo,
        userId: 'test-user',
      }),
      { timeoutMs: 1000 },
    )

    expect(editReply.type).toBe('toolResult')
    if (editReply.type === 'toolResult') {
      expect(editReply.result.text).toContain('Successfully updated')
    }

    // 4. Verify modified content by reading again
    const readVerifyReply = await ask<ToolInvokeMsg, ToolReply>(
      ref,
      (replyTo) => ({
        type: 'invoke',
        toolName: 'read',
        arguments: JSON.stringify({ path: testFilePath }),
        replyTo,
        userId: 'test-user',
      }),
      { timeoutMs: 1000 },
    )

    expect(readVerifyReply.type).toBe('toolResult')
    if (readVerifyReply.type === 'toolResult') {
      const expectedContent = 'This is line one.\nThis is the replaced line.\nThis is line three.'
      expect(readVerifyReply.result.text).toBe(expectedContent)
    }

    // 5. Clean up by running a bash command to delete the file
    await ask<ToolInvokeMsg, ToolReply>(
      ref,
      (replyTo) => ({
        type: 'invoke',
        toolName: 'bash',
        arguments: JSON.stringify({ command: `rm -f ${testFilePath}` }),
        replyTo,
        userId: 'test-user',
      }),
      { timeoutMs: 1000 },
    )

    await system.shutdown()
  })

  test('write supports paths with spaces', async () => {
    const system = await AgentSystem()
    const ref = system.spawn('bash-test-spaced-path', BashTool())
    await tick()

    const spacedFilePath = '/workspace/sao paulo.html'
    const content = '<h1>Sao Paulo</h1>'

    const writeReply = await ask<ToolInvokeMsg, ToolReply>(
      ref,
      (replyTo) => ({
        type: 'invoke',
        toolName: 'write',
        arguments: JSON.stringify({ path: spacedFilePath, content }),
        replyTo,
        userId: 'test-user',
      }),
      { timeoutMs: 1000 },
    )

    expect(writeReply.type).toBe('toolResult')
    if (writeReply.type === 'toolResult') {
      expect(writeReply.result.text).toContain(spacedFilePath)
    }

    const catReply = await ask<ToolInvokeMsg, ToolReply>(
      ref,
      (replyTo) => ({
        type: 'invoke',
        toolName: 'bash',
        arguments: JSON.stringify({ command: "cat '/workspace/sao paulo.html'" }),
        replyTo,
        userId: 'test-user',
      }),
      { timeoutMs: 1000 },
    )

    expect(catReply.type).toBe('toolResult')
    if (catReply.type === 'toolResult') {
      expect(catReply.result.text).toBe(content)
    }

    await ask<ToolInvokeMsg, ToolReply>(
      ref,
      (replyTo) => ({
        type: 'invoke',
        toolName: 'bash',
        arguments: JSON.stringify({ command: "rm -f '/workspace/sao paulo.html'" }),
        replyTo,
        userId: 'test-user',
      }),
      { timeoutMs: 1000 },
    )

    await system.shutdown()
  })

  test('edit supports paths with spaces', async () => {
    const system = await AgentSystem()
    const ref = system.spawn('bash-test-edit-spaced-path', BashTool())
    await tick()

    const spacedFilePath = '/workspace/sao paulo edit.html'
    const initialContent = '<h1>Sao Paulo</h1>\n<p>Draft</p>'
    const expectedContent = '<h1>Sao Paulo</h1>\n<p>Final</p>'

    await ask<ToolInvokeMsg, ToolReply>(
      ref,
      (replyTo) => ({
        type: 'invoke',
        toolName: 'write',
        arguments: JSON.stringify({ path: spacedFilePath, content: initialContent }),
        replyTo,
        userId: 'test-user',
      }),
      { timeoutMs: 1000 },
    )

    const editReply = await ask<ToolInvokeMsg, ToolReply>(
      ref,
      (replyTo) => ({
        type: 'invoke',
        toolName: 'edit',
        arguments: JSON.stringify({
          path: spacedFilePath,
          target: '<p>Draft</p>',
          replacement: '<p>Final</p>',
        }),
        replyTo,
        userId: 'test-user',
      }),
      { timeoutMs: 1000 },
    )

    expect(editReply.type).toBe('toolResult')
    if (editReply.type === 'toolResult') {
      expect(editReply.result.text).toContain(spacedFilePath)
    }

    const catReply = await ask<ToolInvokeMsg, ToolReply>(
      ref,
      (replyTo) => ({
        type: 'invoke',
        toolName: 'bash',
        arguments: JSON.stringify({ command: "cat '/workspace/sao paulo edit.html'" }),
        replyTo,
        userId: 'test-user',
      }),
      { timeoutMs: 1000 },
    )

    expect(catReply.type).toBe('toolResult')
    if (catReply.type === 'toolResult') {
      expect(catReply.result.text).toBe(expectedContent)
    }

    await ask<ToolInvokeMsg, ToolReply>(
      ref,
      (replyTo) => ({
        type: 'invoke',
        toolName: 'bash',
        arguments: JSON.stringify({ command: "rm -f '/workspace/sao paulo edit.html'" }),
        replyTo,
        userId: 'test-user',
      }),
      { timeoutMs: 1000 },
    )

    await system.shutdown()
  })

  test('edit fails with permission error if path is not under /workspace', async () => {
    const system = await AgentSystem()
    const ref = system.spawn('bash-test-6', BashTool())
    await tick()

    const editReply = await ask<ToolInvokeMsg, ToolReply>(
      ref,
      (replyTo) => ({
        type: 'invoke',
        toolName: 'edit',
        arguments: JSON.stringify({
          path: '/rorschach/config.json', // knowledge base is read-only and not under /workspace
          target: 'something',
          replacement: 'else',
        }),
        replyTo,
        userId: 'test-user',
      }),
      { timeoutMs: 1000 },
    )

    expect(editReply.type).toBe('toolError')
    if (editReply.type === 'toolError') {
      expect(editReply.error).toContain('Permission denied')
    }

    await system.shutdown()
  })

  test('edit rejects workspace prefix lookalike paths', async () => {
    const system = await AgentSystem()
    const ref = system.spawn('bash-test-workspace-prefix', BashTool())
    await tick()

    const editReply = await ask<ToolInvokeMsg, ToolReply>(
      ref,
      (replyTo) => ({
        type: 'invoke',
        toolName: 'edit',
        arguments: JSON.stringify({
          path: '/workspace2/file.txt',
          target: 'something',
          replacement: 'else',
        }),
        replyTo,
        userId: 'test-user',
      }),
      { timeoutMs: 1000 },
    )

    expect(editReply.type).toBe('toolError')
    if (editReply.type === 'toolError') {
      expect(editReply.error).toContain('Permission denied')
    }

    await system.shutdown()
  })

  test('edit fails if target block is not found', async () => {
    const system = await AgentSystem()
    const ref = system.spawn('bash-test-7', BashTool())
    await tick()

    const testFilePath = '/workspace/not_found_test.txt'
    await ask<ToolInvokeMsg, ToolReply>(
      ref,
      (replyTo) => ({
        type: 'invoke',
        toolName: 'write',
        arguments: JSON.stringify({ path: testFilePath, content: 'some content here' }),
        replyTo,
        userId: 'test-user',
      }),
      { timeoutMs: 1000 },
    )

    const editReply = await ask<ToolInvokeMsg, ToolReply>(
      ref,
      (replyTo) => ({
        type: 'invoke',
        toolName: 'edit',
        arguments: JSON.stringify({
          path: testFilePath,
          target: 'missing target text',
          replacement: 'new text',
        }),
        replyTo,
        userId: 'test-user',
      }),
      { timeoutMs: 1000 },
    )

    expect(editReply.type).toBe('toolError')
    if (editReply.type === 'toolError') {
      expect(editReply.error).toContain('Target text block not found')
    }

    // Cleanup
    await ask<ToolInvokeMsg, ToolReply>(
      ref,
      (replyTo) => ({
        type: 'invoke',
        toolName: 'bash',
        arguments: JSON.stringify({ command: `rm -f ${testFilePath}` }),
        replyTo,
        userId: 'test-user',
      }),
      { timeoutMs: 1000 },
    )

    await system.shutdown()
  })

  test('edit fails if target block occurs multiple times', async () => {
    const system = await AgentSystem()
    const ref = system.spawn('bash-test-8', BashTool())
    await tick()

    const testFilePath = '/workspace/non_unique_test.txt'
    await ask<ToolInvokeMsg, ToolReply>(
      ref,
      (replyTo) => ({
        type: 'invoke',
        toolName: 'write',
        arguments: JSON.stringify({ path: testFilePath, content: 'duplicate\nduplicate\nunique' }),
        replyTo,
        userId: 'test-user',
      }),
      { timeoutMs: 1000 },
    )

    const editReply = await ask<ToolInvokeMsg, ToolReply>(
      ref,
      (replyTo) => ({
        type: 'invoke',
        toolName: 'edit',
        arguments: JSON.stringify({
          path: testFilePath,
          target: 'duplicate',
          replacement: 'replaced',
        }),
        replyTo,
        userId: 'test-user',
      }),
      { timeoutMs: 1000 },
    )

    expect(editReply.type).toBe('toolError')
    if (editReply.type === 'toolError') {
      expect(editReply.error).toContain('not unique')
    }

    // Cleanup
    await ask<ToolInvokeMsg, ToolReply>(
      ref,
      (replyTo) => ({
        type: 'invoke',
        toolName: 'bash',
        arguments: JSON.stringify({ command: `rm -f ${testFilePath}` }),
        replyTo,
        userId: 'test-user',
      }),
      { timeoutMs: 1000 },
    )

    await system.shutdown()
  })
})
