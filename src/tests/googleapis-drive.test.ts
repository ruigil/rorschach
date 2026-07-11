import { describe, test, expect, mock } from 'bun:test'
import { AgentSystem, ask } from '../system/index.ts'
import { Drive } from '../plugins/googleapis/tools/drive.ts'
import type { ToolInvokeMsg, ToolReply } from '../types/tools.ts'
import type { PersistenceMsg, PResult, PObjGetPayload } from '../types/persistence.ts'
import { MockPersistenceActor } from './mock-persistence.ts'

const tick = (ms = 50) => Bun.sleep(ms)

// Mock the googleapis module
mock.module('googleapis', () => {
  return {
    google: {
      auth: {
        OAuth2: class {
          setCredentials() {}
          async refreshAccessToken() {
            return { credentials: { access_token: 'new-token', expiry_date: Date.now() + 3600 * 1000 } }
          }
        }
      },
      drive: () => ({
        files: {
          list: async () => ({
            data: { files: [{ id: 'file-123', name: 'document.txt', mimeType: 'text/plain' }] }
          }),
          get: async (params: any) => {
            if (params.alt === 'media') {
              return { data: new TextEncoder().encode('hello from google drive').buffer }
            }
            return { data: { name: 'document.txt', mimeType: 'text/plain' } }
          },
          create: async (params: any) => {
            return {
              data: {
                id: 'new-file-id',
                name: params.requestBody.name,
                webViewLink: 'https://drive.google.com/mock-link'
              }
            }
          }
        }
      })
    }
  }
})

describe('Drive actor with persistence store', () => {
  test('drive_download_file exports file and saves to persistence provider using obj.putStream', async () => {
    const system = await AgentSystem()
    const persistenceRef = system.spawn('mock-persistence', MockPersistenceActor())

    // Mock Token Store Actor
    const tokenStoreRef = system.spawn('token-store-mock', {
      handler: (state: null, msg: any) => {
        if (msg.type === 'getToken') {
          msg.replyTo.send({ access_token: 'fake-token', expiry_date: Date.now() + 1000 * 1000 })
        }
        return { state }
      }
    })

    const driveRef = system.spawn(
      'drive-actor',
      Drive(tokenStoreRef, 'client-id', 'client-secret'),
      { state: { persistenceRef: null } }
    )
    await tick()

    const reply = await ask<ToolInvokeMsg, ToolReply>(
      driveRef,
      (replyTo) => ({
        type: 'invoke',
        toolName: 'drive_download_file',
        arguments: JSON.stringify({ fileId: 'file-123' }),
        replyTo,
        userId: 'user-123',
      }),
      { timeoutMs: 1000 }
    )

    expect(reply.type).toBe('toolResult')
    if (reply.type === 'toolResult') {
      expect(reply.result.text).toContain('Downloaded and stored to persistence key: inbound/document.txt')
    }

    // Verify it actually placed it in MockPersistenceActor
    const getRes = await ask<PersistenceMsg, PResult<PObjGetPayload>>(persistenceRef, (replyTo) => ({
      type: 'obj.get',
      bucket: 'media',
      key: 'inbound/document.txt',
      replyTo,
    }))

    expect(getRes.ok).toBe(true)
    if (getRes.ok && getRes.data) {
      const text = new TextDecoder().decode(getRes.data.data)
      expect(text).toBe('hello from google drive')
    }

    await system.shutdown()
  })

  test('drive_upload_file gets stream from persistence and uploads to Google Drive', async () => {
    const system = await AgentSystem()
    const persistenceRef = system.spawn('mock-persistence', MockPersistenceActor())

    // Put a test file into the mock persistence
    const fileContent = new TextEncoder().encode('file to upload content')
    await ask<PersistenceMsg, PResult>(persistenceRef, (replyTo) => ({
      type: 'obj.put',
      bucket: 'media',
      key: 'inbound/upload-test.txt',
      data: fileContent,
      meta: { 'content-type': 'text/plain' },
      replyTo,
    }))

    // Mock Token Store Actor
    const tokenStoreRef = system.spawn('token-store-mock', {
      handler: (state: null, msg: any) => {
        if (msg.type === 'getToken') {
          msg.replyTo.send({ access_token: 'fake-token', expiry_date: Date.now() + 1000 * 1000 })
        }
        return { state }
      }
    })

    const driveRef = system.spawn(
      'drive-actor',
      Drive(tokenStoreRef, 'client-id', 'client-secret'),
      { state: { persistenceRef: null } }
    )
    await tick()

    const reply = await ask<ToolInvokeMsg, ToolReply>(
      driveRef,
      (replyTo) => ({
        type: 'invoke',
        toolName: 'drive_upload_file',
        arguments: JSON.stringify({
          name: 'uploaded-via-test.txt',
          filePath: 'inbound/upload-test.txt'
        }),
        replyTo,
        userId: 'user-123',
      }),
      { timeoutMs: 1000 }
    )

    expect(reply.type).toBe('toolResult')
    if (reply.type === 'toolResult') {
      expect(reply.result.text).toContain('File uploaded: uploaded-via-test.txt')
      expect(reply.result.text).toContain('id: new-file-id')
    }

    await system.shutdown()
  })
})
