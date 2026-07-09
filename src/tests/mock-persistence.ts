import type { PluginDef, ActorRef } from '../system/index.ts'
import { onLifecycle } from '../system/index.ts'
import { PersistenceProviderTopic, type PersistenceMsg } from '../types/persistence.ts'

export const MockPersistenceActor = (): PluginDef<PersistenceMsg, {}> => {
  const kv = new Map<string, unknown>()
  const docs = new Map<string, string>()

  return {
    id: 'mock-persistence',
    version: '0.0.0',
    initialState: {},
    lifecycle: onLifecycle({
      start: async (state, ctx) => {
        ctx.publishRetained(PersistenceProviderTopic, 'data-provider', { ref: ctx.self as ActorRef<PersistenceMsg> })
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

        default:
          replyTo?.send({ ok: false, error: `Mock method not implemented: ${msg.type}` })
          break
      }
      return { state }
    },
  }
}
