import { resolveSafePath, ensureParentDir } from '../utils.ts'
import type { PDocPut, PDocGet, PDocDelete, PDocAppend, PDocList, PDocHead, PResult, PList } from '../../../types/persistence.ts'
import { unlink, readdir, appendFile, stat } from 'node:fs/promises'
import { resolve, join } from 'node:path'

export const DocEngine = (baseDir: string) => {
  const resolvedDir = resolve(baseDir)

  const getFilePath = (collection: string, docId: string): string => {
    const collectionDir = resolveSafePath(resolvedDir, collection)
    return resolveSafePath(collectionDir, docId)
  }

  const put = async (msg: PDocPut): Promise<PResult> => {
    try {
      const filePath = getFilePath(msg.collection, msg.docId)
      await ensureParentDir(filePath)
      await Bun.write(filePath, msg.content)
      return { ok: true }
    } catch (err: any) {
      return { ok: false, error: err.message || String(err) }
    }
  }

  const get = async (msg: PDocGet): Promise<PResult<string>> => {
    try {
      const filePath = getFilePath(msg.collection, msg.docId)
      const file = Bun.file(filePath)
      if (!await file.exists()) {
        return { ok: false, error: `Document not found: ${msg.collection}/${msg.docId}` }
      }
      const content = await file.text()
      return { ok: true, data: content }
    } catch (err: any) {
      return { ok: false, error: err.message || String(err) }
    }
  }

  const del = async (msg: PDocDelete): Promise<PResult> => {
    try {
      const filePath = getFilePath(msg.collection, msg.docId)
      const file = Bun.file(filePath)
      if (await file.exists()) {
        await unlink(filePath)
      }
      return { ok: true }
    } catch (err: any) {
      return { ok: false, error: err.message || String(err) }
    }
  }

  const append = async (msg: PDocAppend): Promise<PResult> => {
    try {
      const filePath = getFilePath(msg.collection, msg.docId)
      await ensureParentDir(filePath)
      await appendFile(filePath, msg.content, 'utf-8')
      return { ok: true }
    } catch (err: any) {
      return { ok: false, error: err.message || String(err) }
    }
  }

  const head = async (msg: PDocHead): Promise<PResult<{ exists: boolean; size?: number; modifiedAt?: string }>> => {
    try {
      const filePath = getFilePath(msg.collection, msg.docId)
      const file = Bun.file(filePath)
      const exists = await file.exists()
      if (!exists) {
        return { ok: true, data: { exists: false } }
      }
      const stats = await stat(filePath)
      return {
        ok: true,
        data: {
          exists: true,
          size: stats.size,
          modifiedAt: stats.mtime.toISOString(),
        },
      }
    } catch (err: any) {
      return { ok: false, error: err.message || String(err) }
    }
  }

  const list = async (msg: PDocList): Promise<PList> => {
    try {
      const collectionDir = resolveSafePath(resolvedDir, msg.collection)
      const keys: string[] = []

      try {
        await stat(collectionDir)
      } catch {
        return { ok: true, keys: [] }
      }

      const prefix = msg.prefix || ''
      const scan = async (dir: string) => {
        let entries
        try {
          entries = await readdir(dir, { withFileTypes: true })
        } catch {
          return
        }
        for (const entry of entries) {
          const fullPath = join(dir, entry.name)
          if (entry.isDirectory()) {
            await scan(fullPath)
          } else if (entry.isFile()) {
            const relativePath = fullPath.substring(collectionDir.length + 1)
            if (relativePath.startsWith(prefix)) {
              keys.push(relativePath)
            }
          }
        }
      }

      await scan(collectionDir)
      return { ok: true, keys }
    } catch (err: any) {
      return { ok: false, error: err.message || String(err) }
    }
  }

  return { put, get, delete: del, append, head, list }
}
