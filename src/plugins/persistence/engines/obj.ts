import { resolveSafePath, ensureParentDir } from '../utils.ts'
import type { PObjPut, PObjGet, PObjPutStream, PObjGetStream, PObjHead, PObjDelete, PObjList, PResult, PObjGetPayload, PObjGetStreamPayload, PObjMeta, PList } from '../../../types/persistence.ts'
import { unlink, readdir, stat } from 'node:fs/promises'
import { resolve, join } from 'node:path'

export const ObjEngine = (baseDir: string) => {
  const resolvedDir = resolve(baseDir)

  const getFilePath = (bucket: string, key: string): string => {
    const bucketDir = resolveSafePath(resolvedDir, bucket)
    return resolveSafePath(bucketDir, key)
  }

  const getMetaPath = (bucket: string, key: string): string => {
    return getFilePath(bucket, key) + '.meta.json'
  }

  const put = async (msg: PObjPut): Promise<PResult> => {
    try {
      const filePath = getFilePath(msg.bucket, msg.key)
      const metaPath = getMetaPath(msg.bucket, msg.key)

      await ensureParentDir(filePath)
      await Bun.write(filePath, msg.data)
      await Bun.write(metaPath, JSON.stringify(msg.meta || {}))
      return { ok: true }
    } catch (err: any) {
      return { ok: false, error: err.message || String(err) }
    }
  }

  const get = async (msg: PObjGet): Promise<PResult<PObjGetPayload>> => {
    try {
      const filePath = getFilePath(msg.bucket, msg.key)
      const metaPath = getMetaPath(msg.bucket, msg.key)

      const file = Bun.file(filePath)
      if (!await file.exists()) {
        return { ok: false, error: `Object not found: ${msg.bucket}/${msg.key}` }
      }

      const fileBuffer = await file.arrayBuffer()
      const data = new Uint8Array(fileBuffer)

      let meta: PObjMeta = {}
      const metaFile = Bun.file(metaPath)
      if (await metaFile.exists()) {
        meta = await metaFile.json()
      }

      return { ok: true, data: { data, meta } }
    } catch (err: any) {
      return { ok: false, error: err.message || String(err) }
    }
  }

  const putStream = async (msg: PObjPutStream): Promise<PResult> => {
    try {
      const filePath = getFilePath(msg.bucket, msg.key)
      const metaPath = getMetaPath(msg.bucket, msg.key)

      await ensureParentDir(filePath)

      if (!msg.stream) {
        throw new Error('Stream is undefined or null')
      }

      const file = Bun.file(filePath)
      const writer = file.writer()

      try {
        if (typeof msg.stream.getReader === 'function') {
          const reader = msg.stream.getReader()
          try {
            while (true) {
              const { done, value } = await reader.read()
              if (done) break
              writer.write(value)
            }
          } finally {
            try {
                reader.releaseLock()
            } catch (e) {
              // Bun bug ?
              //console.warn('Non-fatal: failed to release stream reader lock:', e)
            }
          }
        } else if (msg.stream && typeof (msg.stream as any)[Symbol.asyncIterator] === 'function') {
          for await (const chunk of (msg.stream as any)) {
            writer.write(chunk)
          }
        } else {
          throw new Error('Provided stream is not readable or iterable')
        }

        writer.end()
      } catch (streamErr) {
        writer.end()
        throw streamErr
      }

      await Bun.write(metaPath, JSON.stringify(msg.meta || {}))
      return { ok: true }
    } catch (err: any) {
      const errMsg = err ? (err.message || String(err)) : 'Unknown error'
      const errStack = err?.stack || ''
      //console.error(`putStream error: ${errMsg}\nStack: ${errStack}`)
      return { ok: false, error: errMsg }
    }
  }

  const getStream = async (msg: PObjGetStream): Promise<PResult<PObjGetStreamPayload>> => {
    try {
      const filePath = getFilePath(msg.bucket, msg.key)
      const metaPath = getMetaPath(msg.bucket, msg.key)

      const file = Bun.file(filePath)
      if (!await file.exists()) {
        return { ok: false, error: `Object not found: ${msg.bucket}/${msg.key}` }
      }

      let meta: PObjMeta = {}
      const metaFile = Bun.file(metaPath)
      if (await metaFile.exists()) {
        meta = await metaFile.json()
      }

      return { ok: true, data: { stream: file.stream(), meta } }
    } catch (err: any) {
      return { ok: false, error: err.message || String(err) }
    }
  }

  const head = async (msg: PObjHead): Promise<PResult<PObjMeta>> => {
    try {
      const filePath = getFilePath(msg.bucket, msg.key)
      const metaPath = getMetaPath(msg.bucket, msg.key)

      const file = Bun.file(filePath)
      if (!await file.exists()) {
        return { ok: false, error: `Object not found: ${msg.bucket}/${msg.key}` }
      }

      let meta: PObjMeta = {}
      const metaFile = Bun.file(metaPath)
      if (await metaFile.exists()) {
        meta = await metaFile.json()
      }

      return { ok: true, data: meta }
    } catch (err: any) {
      return { ok: false, error: err.message || String(err) }
    }
  }

  const del = async (msg: PObjDelete): Promise<PResult> => {
    try {
      const filePath = getFilePath(msg.bucket, msg.key)
      const metaPath = getMetaPath(msg.bucket, msg.key)

      const file = Bun.file(filePath)
      if (await file.exists()) {
        await unlink(filePath)
      }
      const metaFile = Bun.file(metaPath)
      if (await metaFile.exists()) {
        await unlink(metaPath)
      }
      return { ok: true }
    } catch (err: any) {
      return { ok: false, error: err.message || String(err) }
    }
  }

  const list = async (msg: PObjList): Promise<PList> => {
    try {
      const bucketDir = resolveSafePath(resolvedDir, msg.bucket)
      const keys: string[] = []

      try {
        await stat(bucketDir)
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
            if (entry.name.endsWith('.meta.json')) {
              continue
            }
            const relativePath = fullPath.substring(bucketDir.length + 1)
            if (relativePath.startsWith(prefix)) {
              keys.push(relativePath)
            }
          }
        }
      }

      await scan(bucketDir)
      return { ok: true, keys }
    } catch (err: any) {
      return { ok: false, error: err.message || String(err) }
    }
  }

  return { put, get, putStream, getStream, head, delete: del, list }
}
