import type { ActorDef, ActorRef, ActorContext } from '../../system/index.ts'
import { onLifecycle } from '../../system/index.ts'
import type { PersistenceMsg } from '../../types/persistence.ts'
import { PersistenceProviderTopic } from '../../types/persistence.ts'
import type { PersistenceConfig } from './types.ts'
import { KvEngine } from './engines/kv.ts'
import { DocEngine } from './engines/doc.ts'
import { ObjEngine } from './engines/obj.ts'
import { GraphEngine } from './engines/graph.ts'
import { join } from 'node:path'

type InternalPersistenceMsg = PersistenceMsg | { type: '_void' }

export const PersistenceActor = (config: PersistenceConfig): ActorDef<InternalPersistenceMsg, {}> => {
  const storageRoot = config.storageRoot || 'workspace/persistence'
  const kvDir = join(storageRoot, config.kvDir || 'kv')
  const docDir = join(storageRoot, config.docDir || 'doc')
  const objDir = join(storageRoot, config.objDir || 'obj')
  const graphDir = join(storageRoot, config.graphDir || 'graph')

  const kvEngine = KvEngine(kvDir)
  const docEngine = DocEngine(docDir)
  const objEngine = ObjEngine(objDir)
  const graphEngine = GraphEngine(graphDir)

  const handleAsync = <T>(
    promise: Promise<T>,
    replyTo: ActorRef<T> | undefined,
    ctx: ActorContext<InternalPersistenceMsg>,
  ) => {
    ctx.pipeToSelf(
      promise,
      (res) => {
        replyTo?.send(res)
        return { type: '_void' as const }
      },
      (err: any) => {
        replyTo?.send({ ok: false, error: err.message || String(err) } as any)
        return { type: '_void' as const }
      },
    )
  }

  return {
    initialState: {},
    lifecycle: onLifecycle({
      start: async (state, ctx) => {
        ctx.publishRetained(PersistenceProviderTopic, 'data-provider', { ref: ctx.self as ActorRef<PersistenceMsg> })
        ctx.log.info('persistence actor started', { storageRoot })
        return { state }
      },
      stopped: async (state, ctx) => {
        graphEngine.close()
        ctx.log.info('persistence actor stopped')
        return { state }
      },
    }),
    handler: (state, msg, ctx) => {
      if (msg.type === '_void') {
        return { state }
      }

      const replyTo = msg.replyTo as any

      switch (msg.type) {
        // KV Store
        case 'kv.put':
          handleAsync(kvEngine.put(msg), replyTo, ctx)
          break
        case 'kv.get':
          handleAsync(kvEngine.get(msg), replyTo, ctx)
          break
        case 'kv.delete':
          handleAsync(kvEngine.delete(msg), replyTo, ctx)
          break
        case 'kv.list':
          handleAsync(kvEngine.list(msg), replyTo, ctx)
          break

        // Document Store
        case 'doc.put':
          handleAsync(docEngine.put(msg), replyTo, ctx)
          break
        case 'doc.get':
          handleAsync(docEngine.get(msg), replyTo, ctx)
          break
        case 'doc.delete':
          handleAsync(docEngine.delete(msg), replyTo, ctx)
          break
        case 'doc.append':
          handleAsync(docEngine.append(msg), replyTo, ctx)
          break
        case 'doc.head':
          handleAsync(docEngine.head(msg), replyTo, ctx)
          break
        case 'doc.list':
          handleAsync(docEngine.list(msg), replyTo, ctx)
          break

        // Object Store
        case 'obj.put':
          handleAsync(objEngine.put(msg), replyTo, ctx)
          break
        case 'obj.putStream':
          handleAsync(objEngine.putStream(msg), replyTo, ctx)
          break
        case 'obj.get':
          handleAsync(objEngine.get(msg), replyTo, ctx)
          break
        case 'obj.getStream':
          handleAsync(objEngine.getStream(msg), replyTo, ctx)
          break
        case 'obj.head':
          handleAsync(objEngine.head(msg), replyTo, ctx)
          break
        case 'obj.delete':
          handleAsync(objEngine.delete(msg), replyTo, ctx)
          break
        case 'obj.list':
          handleAsync(objEngine.list(msg), replyTo, ctx)
          break

        // Graph Store
        case 'graph.upsert':
          handleAsync(graphEngine.upsert(msg), replyTo, ctx)
          break
        case 'graph.search':
          handleAsync(graphEngine.search(msg), replyTo, ctx)
          break
        case 'graph.query':
          handleAsync(graphEngine.query(msg), replyTo, ctx)
          break
        case 'graph.delete':
          handleAsync(graphEngine.delete(msg), replyTo, ctx)
          break
      }
      return { state }
    },
  }
}
