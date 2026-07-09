import { resolveSafePath, ensureParentDir } from '../utils.ts'
import type { PKVPut, PKVGet, PKVDelete, PKVList, PResult, PList } from '../../../types/persistence.ts'
import { unlink, readdir } from 'node:fs/promises'
import { resolve, join } from 'node:path'

export const KvEngine = (baseDir: string) => {
  const resolvedDir = resolve(baseDir)

  const getFilePath = (key: string): string => {
    return resolveSafePath(resolvedDir, `${key}.json`)
  }

  const put = async (msg: PKVPut): Promise<PResult> => {
    try {
      const filePath = getFilePath(msg.key)
      await ensureParentDir(filePath)
      const dataStr = JSON.stringify(msg.value, null, 2)
      await Bun.write(filePath, dataStr)
      return { ok: true }
    } catch (err: any) {
      return { ok: false, error: err.message || String(err) }
    }
  }

  const get = async (msg: PKVGet): Promise<PResult<unknown>> => {
    try {
      const filePath = getFilePath(msg.key)
      const file = Bun.file(filePath)
      if (!await file.exists()) {
        return { ok: false, error: `Key not found: ${msg.key}` }
      }
      const data = await file.json()
      return { ok: true, data }
    } catch (err: any) {
      return { ok: false, error: err.message || String(err) }
    }
  }

  const del = async (msg: PKVDelete): Promise<PResult> => {
    try {
      const filePath = getFilePath(msg.key)
      const file = Bun.file(filePath)
      if (await file.exists()) {
        await unlink(filePath)
      }
      return { ok: true }
    } catch (err: any) {
      return { ok: false, error: err.message || String(err) }
    }
  }

  const list = async (msg: PKVList): Promise<PList> => {
    try {
      const targetDir = resolveSafePath(resolvedDir, msg.prefix)
      const keys: string[] = []

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
          } else if (entry.isFile() && entry.name.endsWith('.json')) {
            const relativePath = fullPath.substring(resolvedDir.length + 1)
            const key = relativePath.substring(0, relativePath.length - 5)
            keys.push(key)
          }
        }
      }

      await scan(targetDir)
      return { ok: true, keys }
    } catch (err: any) {
      return { ok: false, error: err.message || String(err) }
    }
  }

  return { put, get, delete: del, list }
}
