import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createPluginSystem, ask } from '../system/index.ts'
import { createNotesActor, NOTES_ATTACH_FILE_TOOL_NAME, NOTES_CREATE_TOOL_NAME, NOTES_READ_TOOL_NAME } from '../plugins/notebook/tools/notes.ts'
import type { ToolInvokeMsg, ToolReply } from '../types/tools.ts'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

describe('notebook notes', () => {
  test('returns stable attachment route links when reading notes', async () => {
    const system = await createPluginSystem()
    const dir = join(tmpdir(), `rorschach-notes-${crypto.randomUUID()}`)
    tempDirs.push(dir)
    await mkdir(dir, { recursive: true })

    const sourceFile = join(dir, 'My File #1.pdf')
    await writeFile(sourceFile, 'pdf')

    const notesRef = system.spawn('notes', createNotesActor(dir), null)

    const createReply = await ask<ToolInvokeMsg, ToolReply>(notesRef, replyTo => ({
      type: 'invoke',
      toolName: NOTES_CREATE_TOOL_NAME,
      arguments: JSON.stringify({ title: 'Attachment Test', content: 'See attachment.', tags: ['test'] }),
      replyTo,
      userId: 'test-user',
    }))
    expect(createReply.type).toBe('toolResult')
    if (createReply.type !== 'toolResult') throw new Error('create failed')

    const id = createReply.result.match(/id=([^,]+)/)?.[1]
    expect(id).toBeTruthy()

    const attachReply = await ask<ToolInvokeMsg, ToolReply>(notesRef, replyTo => ({
      type: 'invoke',
      toolName: NOTES_ATTACH_FILE_TOOL_NAME,
      arguments: JSON.stringify({ id, filePath: sourceFile }),
      replyTo,
      userId: 'test-user',
    }))
    expect(attachReply.type).toBe('toolResult')

    const readReply = await ask<ToolInvokeMsg, ToolReply>(notesRef, replyTo => ({
      type: 'invoke',
      toolName: NOTES_READ_TOOL_NAME,
      arguments: JSON.stringify({ id }),
      replyTo,
      userId: 'test-user',
    }))

    expect(readReply.type).toBe('toolResult')
    if (readReply.type === 'toolResult') {
      expect(readReply.result).toContain('Attachments:')
      expect(readReply.result).toContain('[My File #1.pdf](/notebook/attachments/')
      expect(readReply.result).not.toContain('/inbound/My File #1.pdf')
    }

    await system.shutdown()
  })
})
