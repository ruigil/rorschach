import { describe, expect, test, beforeAll, afterAll } from 'bun:test'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { AgentSystem, type ActorRef } from '../system/index.ts'
import { OutboundUserMessageTopic, HttpWsFrameTopic } from '../types/events.ts'
import { NotebookManager } from '../plugins/notebook/notebook-manager.ts'
import { ProjectShell } from '../plugins/coding/project-shell.ts'
import { MockPersistenceActor } from './mock-persistence.ts'
import { gateWsFrame } from '../system/permissions/edge.ts'

describe('Edge Gating (Membrane 3)', () => {
  const root = join(process.cwd(), 'scratch', 'permissions-edge-gating-test')
  const projectRoot = join(root, 'project')
  const workspaceDir = join(root, 'workspace')

  beforeAll(() => {
    rmSync(root, { recursive: true, force: true })
    mkdirSync(projectRoot, { recursive: true })
    mkdirSync(workspaceDir, { recursive: true })
  })

  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
  })

  test('writes structured permission_denied audit log on denial', () => {
    let denialLog: { msg: string; meta: Record<string, unknown> } | null = null
    const logger = {
      warn: (msg: string, meta?: any) => {
        if (meta?.event === 'permission_denied') denialLog = { msg, meta }
      },
    }

    const allowed = gateWsFrame(
      { userId: 'u1', permission: { grants: [] } },
      'coding_shell_exec',
      logger,
      'ws_terminal',
    )

    expect(allowed).toBe(false)
    expect(denialLog).not.toBeNull()
    expect(denialLog!.meta).toEqual({
      event: 'permission_denied',
      userId: 'u1',
      toolName: 'coding_shell_exec',
      surface: 'ws_terminal',
      reason: 'missing_grant',
    })
  })

  test('blocks unauthorized notebook/todo mutations and terminal commands', async () => {
    const system = await AgentSystem({ plugins: [MockPersistenceActor()] })
    const messages: Array<{ userId: string; text: string }> = []
    system.subscribe(OutboundUserMessageTopic, event => {
      messages.push(event as { userId: string; text: string })
    })

    // Spawn NotebookManager and ProjectShell
    system.spawn('notebook-manager', NotebookManager())
    system.spawn('project-shell', ProjectShell({
      projectRoot,
      projectMount: '/rorschach',
      workspaceDir,
    }))

    // Wait a brief moment for setup
    await Bun.sleep(100)

    const waitMessages = async (count: number, timeout = 1000) => {
      const start = Date.now()
      while (messages.length < count && Date.now() - start < timeout) {
        await Bun.sleep(10)
      }
    }

    // 1. notebook.todos.request: Denied for empty grants
    messages.length = 0
    system.publish(HttpWsFrameTopic, {
      clientId: 'c1',
      userId: 'u1',
      roles: [],
      frame: { type: 'notebook.todos.request' },
      permission: { grants: [] } // Empty grants context
    })
    await waitMessages(1)
    expect(messages).toHaveLength(1)
    const errFrame = JSON.parse(messages[0]!.text)
    expect(errFrame.type).toBe('notebook.error')
    expect(errFrame.message).toBe('user not authorized')

    // 2. notebook.todos.request: Allowed for notebook_* grants
    messages.length = 0
    system.publish(HttpWsFrameTopic, {
      clientId: 'c1',
      userId: 'u1',
      roles: [],
      frame: { type: 'notebook.todos.request' },
      permission: { grants: ['notebook_*'] }
    })
    await waitMessages(1)
    expect(messages).toHaveLength(1)
    const allowedFrame = JSON.parse(messages[0]!.text)
    expect(allowedFrame.type).not.toBe('notebook.error') // Should not return not authorized error

    // 3. coding.bash.command: Denied for empty grants
    messages.length = 0
    system.publish(HttpWsFrameTopic, {
      clientId: 'c1',
      userId: 'u1',
      roles: [],
      frame: { type: 'coding.bash.command', command: 'pwd', cmdId: 'cmd1' },
      permission: { grants: [] }
    })
    await waitMessages(1)
    expect(messages).toHaveLength(1)
    const bashErrFrame = JSON.parse(messages[0]!.text)
    expect(bashErrFrame.type).toBe('coding.bash.response')
    expect(bashErrFrame.error).toBe('user not authorized')
    expect(bashErrFrame.exitCode).toBe(-1)

    // 4. coding.bash.command: Allowed for coding_* grants
    messages.length = 0
    system.publish(HttpWsFrameTopic, {
      clientId: 'c1',
      userId: 'u1',
      roles: [],
      frame: { type: 'coding.bash.command', command: 'pwd', cmdId: 'cmd2' },
      permission: { grants: ['coding_*'] }
    })
    await waitMessages(1)
    expect(messages).toHaveLength(1)
    const bashAllowedFrame = JSON.parse(messages[0]!.text)
    expect(bashAllowedFrame.type).toBe('coding.bash.response')
    expect(bashAllowedFrame.error).toBeUndefined()

    await system.shutdown()
  })
})
