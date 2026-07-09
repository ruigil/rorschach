import { resolveSafePath, ensureParentDir } from '../utils.ts'
import type { PObjPut, PObjGet, PObjGetUrl, PObjHead, PObjDelete, PObjList, PResult, PObjGetPayload, PObjGetUrlPayload, PObjMeta, PList } from '../../../types/persistence.ts'
import { unlink, readdir, stat } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import type { Server } from 'bun'

export const ObjEngine = (baseDir: string) => {
  const resolvedDir = resolve(baseDir)
  let server: Server<any> | null = null

  const getFilePath = (bucket: string, key: string): string => {
    const bucketDir = resolveSafePath(resolvedDir, bucket)
    return resolveSafePath(bucketDir, key)
  }

  const getMetaPath = (bucket: string, key: string): string => {
    return getFilePath(bucket, key) + '.meta.json'
  }

  const startServer = (): void => {
    if (server) return

    server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      async fetch(req) {
        const url = new URL(req.url)
        const pathname = decodeURIComponent(url.pathname)
        const relativePath = pathname.substring(1)

        if (!relativePath) {
          return new Response('Not found', { status: 404 })
        }

        try {
          const filePath = resolveSafePath(resolvedDir, relativePath)
          if (filePath.endsWith('.meta.json')) {
            return new Response('Forbidden', { status: 403 })
          }

          const file = Bun.file(filePath)
          if (!await file.exists()) {
            return new Response('Not found', { status: 404 })
          }

          let contentType = 'application/octet-stream'
          try {
            const metaPath = filePath + '.meta.json'
            const metaFile = Bun.file(metaPath)
            if (await metaFile.exists()) {
              const meta = await metaFile.json()
              if (meta['content-type']) {
                contentType = meta['content-type']
              } else if (meta['Content-Type']) {
                contentType = meta['Content-Type']
              }
            }
          } catch {
            // Fall back to default
          }

          return new Response(file, {
            headers: {
              'Content-Type': contentType,
              'Access-Control-Allow-Origin': '*',
            },
          })
        } catch {
          return new Response('Not found', { status: 404 })
        }
      },
    })
  }

  const stopServer = (): void => {
    if (server) {
      server.stop(true)
      server = null
    }
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

  const getUrl = async (msg: PObjGetUrl): Promise<PResult<PObjGetUrlPayload>> => {
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

      if (!server) {
        startServer()
      }

      const url = `http://127.0.0.1:${server?.port ?? 0}/${msg.bucket}/${msg.key}`
      return { ok: true, data: { url, meta } }
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

  return { startServer, stopServer, put, get, getUrl, head, delete: del, list }
}
