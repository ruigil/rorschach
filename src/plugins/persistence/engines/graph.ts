import { resolveSafePath } from '../utils.ts'
import type { PGraphUpsert, PGraphSearch, PGraphQuery, PGraphDelete, PResult, GraphNode } from '../../../types/persistence.ts'
import { GrafeoDB } from '@grafeo-db/js'
import { resolve } from 'node:path'

export const GraphEngine = (baseDir: string) => {
  const resolvedDir = resolve(baseDir)
  const dbs = new Map<string, GrafeoDB>()

  const resolveDb = (graphId: string): GrafeoDB => {
    let db = dbs.get(graphId)
    if (db) return db
    const dbDir = resolveSafePath(resolvedDir, graphId)
    db = GrafeoDB.create(dbDir)
    dbs.set(graphId, db)
    return db
  }

  const close = (): void => {
    for (const db of dbs.values()) {
      try {
        db.close()
      } catch {
        // Ignore close errors
      }
    }
    dbs.clear()
  }

  const upsert = async (msg: PGraphUpsert): Promise<PResult<{ nodeIds: string[] }>> => {
    try {
      const db = resolveDb(msg.graphId)

      for (const node of msg.nodes) {
        if (node.embedding) {
          const label = node.type || 'Concept'
          try {
            await db.createVectorIndex(label, '_embedding', node.embedding.length, 'cosine')
          } catch {
            // Index already exists, ignore
          }
        }
      }

      const tx = db.beginTransaction()
      const nodeIds: string[] = []
      try {
        for (const node of msg.nodes) {
          const nodeId = node.id
          const existing = await tx.execute(`MATCH (n) WHERE n.id = $id RETURN id(n) AS internalId`, { id: nodeId })
          const rows = existing.toArray()
          let internalId: number

          if (rows.length > 0) {
            internalId = (rows[0] as any).internalId
            const setClauses: string[] = []
            for (const [k, v] of Object.entries(node.properties)) {
              setClauses.push(`n.${k} = ${JSON.stringify(v)}`)
            }
            if (node.embedding) {
              const vectorStr = `vector([${node.embedding.join(',')}])`
              setClauses.push(`n._embedding = ${vectorStr}`)
            }
            if (setClauses.length > 0) {
              await tx.execute(`MATCH (n) WHERE id(n) = ${internalId} SET ${setClauses.join(', ')}`)
            }
          } else {
            const label = node.type || 'Concept'
            const propsList: string[] = [`id: ${JSON.stringify(nodeId)}`]
            for (const [k, v] of Object.entries(node.properties)) {
              propsList.push(`${k}: ${JSON.stringify(v)}`)
            }
            if (node.embedding) {
              const vectorStr = `vector([${node.embedding.join(',')}])`
              propsList.push(`_embedding: ${vectorStr}`)
            }
            const query = `INSERT (n:${label} { ${propsList.join(', ')} }) RETURN n`
            const res = await tx.execute(query)
            const createdNode = res.nodes()[0]
            if (!createdNode) {
              throw new Error('INSERT query did not return the created node')
            }
            internalId = createdNode.id
          }
          nodeIds.push(String(internalId))
        }

        for (const edge of msg.edges) {
          const srcId = edge.source
          const tgtId = edge.target
          const edgeType = edge.type || 'RELATES_TO'

          const setClauses: string[] = []
          if (edge.properties) {
            for (const [k, v] of Object.entries(edge.properties)) {
              setClauses.push(`r.${k} = ${JSON.stringify(v)}`)
            }
          }

          const query = `
            MATCH (a { id: ${JSON.stringify(srcId)} }), (b { id: ${JSON.stringify(tgtId)} })
            MERGE (a)-[r:${edgeType}]->(b)
            ` + (setClauses.length > 0 ? `SET ${setClauses.join(', ')} ` : '') +
            `RETURN r`

          await tx.execute(query)
        }
        tx.commit()
      } catch (txErr) {
        tx.rollback()
        throw txErr
      }
      return { ok: true, data: { nodeIds } }
    } catch (err: any) {
      return { ok: false, error: err.message || String(err) }
    }
  }

  const search = async (msg: PGraphSearch): Promise<PResult<GraphNode[]>> => {
    try {
      const db = resolveDb(msg.graphId)
      const vectorStr = `vector([${msg.embedding.join(',')}])`
      const query = `
        MATCH (n)
        WHERE n._embedding IS NOT NULL
        RETURN id(n) AS nodeId, labels(n) AS labels, n AS node, cosine_similarity(n._embedding, ${vectorStr}) AS score
        ORDER BY score DESC
        LIMIT ${Math.max(1, msg.topK)}
      `
      const result = await db.execute(query)
      const nodes = result.toArray().map((row: any) => {
        const type = Array.isArray(row.labels) ? row.labels[0] || 'Node' : 'Node'
        const properties = { ...row.node }
        delete properties._embedding
        const id = typeof properties.id === 'string' ? properties.id : String(row.nodeId)
        return {
          id,
          type,
          properties,
        }
      })
      return { ok: true, data: nodes }
    } catch (err: any) {
      return { ok: false, error: err.message || String(err) }
    }
  }

  const query = async (msg: PGraphQuery): Promise<PResult<Record<string, unknown>[]>> => {
    try {
      const db = resolveDb(msg.graphId)
      const result = await db.execute(msg.cypher, msg.params)
      return { ok: true, data: result.toArray() as Record<string, unknown>[] }
    } catch (err: any) {
      return { ok: false, error: err.message || String(err) }
    }
  }

  const del = async (msg: PGraphDelete): Promise<PResult> => {
    try {
      const db = resolveDb(msg.graphId)
      for (const id of msg.nodeIds) {
        const numId = Number(id)
        if (!isNaN(numId)) {
          db.deleteNode(numId)
        } else {
          await db.execute(`MATCH (n) WHERE n.id = $id DETACH DELETE n`, { id })
        }
      }
      return { ok: true }
    } catch (err: any) {
      return { ok: false, error: err.message || String(err) }
    }
  }

  return { close, upsert, search, query, delete: del }
}
