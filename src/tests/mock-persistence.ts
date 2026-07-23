import type { PluginDef, ActorRef } from '../system/index.ts'
import { onLifecycle } from '../system/index.ts'
import { PersistenceProviderTopic, type PersistenceMsg } from '../types/persistence.ts'

export const MockPersistenceActor = (): PluginDef<PersistenceMsg, {}> => {
  const kv = new Map<string, unknown>()
  const docs = new Map<string, string>()
  const objects = new Map<string, { data: Uint8Array; meta: Record<string, string> }>()

  return {
    id: 'mock-persistence',
    version: '0.0.0',
    initialState: {},
    lifecycle: onLifecycle({
      start: async (state, ctx) => {
        ctx.publishRetained(PersistenceProviderTopic, 'provider', { ref: ctx.self as ActorRef<PersistenceMsg> })
        return { state }
      },
    }),
    handler: (state, msg, ctx) => {
      const replyTo = msg.replyTo as ActorRef<any>
      switch (msg.type) {
        case 'kv.put':
          kv.set(msg.key, msg.value)
          replyTo?.send({ ok: true })
          break
        case 'kv.get':
          if (kv.has(msg.key)) {
            replyTo?.send({ ok: true, data: kv.get(msg.key) })
          } else {
            replyTo?.send({ ok: false, error: `Key not found: ${msg.key}` })
          }
          break
        case 'kv.delete':
          kv.delete(msg.key)
          replyTo?.send({ ok: true })
          break
        case 'kv.list':
          const keys = Array.from(kv.keys()).filter(k => k.startsWith(msg.prefix))
          replyTo?.send({ ok: true, keys })
          break

        case 'doc.put':
          docs.set(`${msg.collection}/${msg.docId}`, msg.content)
          replyTo?.send({ ok: true })
          break
        case 'doc.get':
          const docKey = `${msg.collection}/${msg.docId}`
          if (docs.has(docKey)) {
            replyTo?.send({ ok: true, data: docs.get(docKey) })
          } else {
            replyTo?.send({ ok: false, error: `Doc not found: ${docKey}` })
          }
          break
        case 'doc.delete':
          docs.delete(`${msg.collection}/${msg.docId}`)
          replyTo?.send({ ok: true })
          break
        case 'doc.append':
          const appKey = `${msg.collection}/${msg.docId}`
          const current = docs.get(appKey) || ''
          docs.set(appKey, current + msg.content)
          replyTo?.send({ ok: true })
          break
        case 'doc.head':
          const headKey = `${msg.collection}/${msg.docId}`
          const exists = docs.has(headKey)
          replyTo?.send({
            ok: true,
            data: {
              exists,
              size: exists ? docs.get(headKey)!.length : undefined,
            },
          })
          break
        case 'doc.list':
          const collPrefix = `${msg.collection}/`
          const matchPrefix = msg.prefix ? `${msg.collection}/${msg.prefix}` : collPrefix
          const docKeys = Array.from(docs.keys())
            .filter(k => k.startsWith(matchPrefix))
            .map(k => k.substring(collPrefix.length))
          replyTo?.send({ ok: true, keys: docKeys })
          break

        // Object Store
        case 'obj.put':
          objects.set(`${msg.bucket}/${msg.key}`, { data: msg.data, meta: msg.meta || {} })
          replyTo?.send({ ok: true })
          break
        case 'obj.putStream':
          readStream(msg.stream).then(
            (data) => {
              objects.set(`${msg.bucket}/${msg.key}`, { data, meta: msg.meta || {} })
              replyTo?.send({ ok: true })
            },
            (err) => {
              replyTo?.send({ ok: false, error: err.message || String(err) })
            }
          )
          break
        case 'obj.get': {
          const objKey = `${msg.bucket}/${msg.key}`
          const found = objects.get(objKey)
          if (found) {
            replyTo?.send({ ok: true, data: { data: found.data, meta: found.meta } })
          } else {
            replyTo?.send({ ok: false, error: `Object not found: ${msg.bucket}/${msg.key}` })
          }
          break
        }
        case 'obj.getStream': {
          const objKey = `${msg.bucket}/${msg.key}`
          const found = objects.get(objKey)
          if (found) {
            const stream = new ReadableStream({
              start(controller) {
                controller.enqueue(found.data)
                controller.close()
              }
            })
            replyTo?.send({ ok: true, data: { stream, meta: found.meta } })
          } else {
            replyTo?.send({ ok: false, error: `Object not found: ${msg.bucket}/${msg.key}` })
          }
          break
        }
        case 'obj.head': {
          const objKey = `${msg.bucket}/${msg.key}`
          const found = objects.get(objKey)
          if (found) {
            replyTo?.send({ ok: true, data: found.meta })
          } else {
            replyTo?.send({ ok: false, error: `Object not found: ${msg.bucket}/${msg.key}` })
          }
          break
        }
        case 'obj.delete':
          objects.delete(`${msg.bucket}/${msg.key}`)
          replyTo?.send({ ok: true })
          break
        case 'obj.list': {
          const bucketPrefix = `${msg.bucket}/`
          const matchPrefix = msg.prefix ? `${msg.bucket}/${msg.prefix}` : bucketPrefix
          const keys = Array.from(objects.keys())
            .filter(k => k.startsWith(matchPrefix))
            .map(k => k.substring(bucketPrefix.length))
          replyTo?.send({ ok: true, keys })
          break
        }

        default:
          replyTo?.send({ ok: false, error: `Mock method not implemented: ${msg.type}` })
          break
      }
      return { state }
    },
  }
}

const readStream = async (stream: ReadableStream<Uint8Array>): Promise<Uint8Array> => {
  const chunks: Uint8Array[] = []
  const reader = stream.getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const totalLength = chunks.reduce((acc, c) => acc + c.length, 0)
  const result = new Uint8Array(totalLength)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.length
  }
  return result
}
