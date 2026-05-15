import { mkdir } from 'node:fs/promises'
import type { ActorDef, ActorRef } from '../../system/types.ts'
import { onLifecycle, onMessage } from '../../system/match.ts'
import { ask } from '../../system/ask.ts'
import { defineTool } from '../../types/tools.ts'
import type { ToolInvokeMsg, ToolReply } from '../../types/tools.ts'
import { ZETTEL_LINK_TYPES } from './types.ts'
import type { KgraphMsg, ZettelLink, ZettelLinkType, ZettelNote, ZettelIndex, VectorSearchReply } from './types.ts'

export const zettelCreateTool = defineTool('zettel_create', 'Create a new atomic Zettelkasten note capturing a self-contained unit of knowledge.', {
  type: 'object',
  properties: {
    name: { type: 'string', description: 'Short note title (2-5 words, Title Case).' },
    synopsis: { type: 'string', description: "Comma-separated list of query topics that would find this note. Used for semantic search." },
    content: { type: 'string', description: 'Full markdown content.' },
    tags: { type: 'array', items: { type: 'string' }, description: 'Lowercase tags e.g. ["typescript", "work", "preference"].' },
    eventTime: { type: 'string', description: 'Optional ISO 8601 timestamp for when the event occurred (if different from now).' },
    userId: { type: 'string' },
  },
  required: ['name', 'synopsis', 'content', 'tags'],
})

export const zettelUpdateTool = defineTool('zettel_update', 'Update an existing Zettelkasten note. Only pass fields that should change. Re-embeds with fresh synopsis.', {
  type: 'object',
  properties: {
    id: { type: 'string', description: 'Note UUID.' },
    name: { type: 'string', description: 'Updated title (optional).' },
    synopsis: { type: 'string', description: 'Updated comma-separated list of query topics (optional).' },
    content: { type: 'string', description: 'Full updated markdown content (optional).' },
    tags: { type: 'array', items: { type: 'string' }, description: 'Updated tags (optional).' },
    eventTime: { type: 'string', description: 'Updated ISO 8601 timestamp (optional).' },
    userId: { type: 'string' },
  },
  required: ['id'],
})

export const zettelSearchTool = defineTool('zettel_search', 'Semantic search via vector embeddings and re-ranking. Finds notes similar to the given text and re-ranks by similarity. Each result includes a score (0-1) indicating semantic closeness.', {
  type: 'object',
  properties: {
    text: { type: 'string', description: 'Comma-separated list of query topics to search for. Must be a declarative summary, not a question.' },
    tags: { type: 'array', items: { type: 'string' }, description: 'Required tags to enrich the vector query and filter results. Must match ALL provided tags.' },
    after: { type: 'string', description: 'Optional. Filter results to notes on or after this ISO 8601 timestamp.' },
    before: { type: 'string', description: 'Optional. Filter results to notes on or before this ISO 8601 timestamp.' },
    timeProperty: {
      type: 'string',
      enum: ['eventTime', 'createdAt', 'updatedAt'],
      default: 'eventTime',
      description: 'Which timestamp to use for the before/after filter.',
    },
    userId: { type: 'string' },
  },
  required: ['text', 'tags'],
})

export const zettelLinksTool = defineTool('zettel_links', 'Return the notes linked from a given note. Returns id, name, synopsis, tags, links, and full content for each linked note that exists.', {
  type: 'object',
  properties: {
    id: { type: 'string', description: 'Note UUID.' },
    name: { type: 'string', description: 'Note title (used if id is not provided).' },
    userId: { type: 'string' },
  },
})

export const zettelUnlinkedTool = defineTool('zettel_unlinked_notes', 'Get all notes that have no incoming links (orphans) or exactly one outgoing link. Useful for consolidation to find notes that need to be connected to the broader knowledge graph.', {
  type: 'object',
  properties: {
    userId: { type: 'string' },
  },
})

export const zettelLinkTool = defineTool('zettel_link', 'Create a link between two notes in the knowledge graph. If a note does not exist, it will be created automatically.', {
  type: 'object',
  properties: {
    fromId: { type: 'string', description: 'UUID of the source note.' },
    toId: { type: 'string', description: 'UUID of the target note.' },
    linkType: { type: 'string', enum: ZETTEL_LINK_TYPES, description: 'Type of relationship.' },
    userId: { type: 'string' },
  },
  required: ['fromId', 'toId', 'linkType'],
})



// ─── State & messages ───

type ZettelState = { kgraphRef: ActorRef<KgraphMsg>; dbPath: string } 

export type ZettelNoteMsg =
  | ToolInvokeMsg
  | { type: '_done'; replyTo: ActorRef<ToolReply>; result: string }
  | { type: '_error'; replyTo: ActorRef<ToolReply>; error: string }

// ─── File helpers ───

const slugify = (name: string): string =>
  name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

const getBasePath = (userId: string, dbPath: string) => `${dbPath}/${userId}`

const indexPath = (userId: string, dbPath: string) => `${getBasePath(userId, dbPath)}/notes/index.json`
const noteFilePath = (userId: string, meta: Pick<ZettelNote, 'path'>, dbPath: string) =>
  `${getBasePath(userId, dbPath)}/${meta.path}`

// ─── Serialized index mutation queue ───
//
// Multiple concurrent pipeToSelf calls would each read the same stale index.json
// and overwrite each other. Chaining mutations through a per-userId promise queue
// ensures each operation sees the result of the previous one without re-reading disk.

const makeIndexQueue = (dbPath: string) => {
  const queues = new Map<string, Promise<ZettelIndex>>()

  const current = (userId: string): Promise<ZettelIndex> =>
    (queues.get(userId) ?? readIndex(userId, dbPath)).catch(() => readIndex(userId, dbPath))

  const mutate = (userId: string, fn: (idx: ZettelIndex) => ZettelIndex): Promise<ZettelIndex> => {
    const next = current(userId).then(async (idx) => {
      const updated = fn(idx)
      await writeIndex(userId, updated, dbPath)
      return updated
    })
    queues.set(userId, next.catch(() => readIndex(userId, dbPath)))
    return next
  }

  return { current, mutate }
}

const readIndex = async (userId: string, dbPath: string): Promise<ZettelIndex> => {
  try {
    const text = await Bun.file(indexPath(userId, dbPath)).text()
    return JSON.parse(text) as ZettelIndex
  } catch {
    return { notes: [] }
  }
}

const writeIndex = async (userId: string, index: ZettelIndex, dbPath: string): Promise<void> => {
  await mkdir(`${getBasePath(userId, dbPath)}/notes`, { recursive: true })
  await Bun.write(indexPath(userId, dbPath), JSON.stringify(index, null, 2))
}

const serializeNote = (meta: ZettelNote, body: string): string => {
  const tags = meta.tags.length > 0 ? `[${meta.tags.join(', ')}]` : '[]'
  const links = meta.links.length > 0 ? `[${meta.links.map(l => `${l.type}:${l.name}`).join(', ')}]` : '[]'
  const eventTime = meta.eventTime ? `\neventTime: ${meta.eventTime}` : ''
  const nodeId = meta.kgraphNodeId !== undefined ? `\nkgraphNodeId: ${meta.kgraphNodeId}` : ''
  return `---\nid: ${meta.id}\nname: ${meta.name}\nsynopsis: ${meta.synopsis}\ntags: ${tags}\ncreatedAt: ${meta.createdAt}\nupdatedAt: ${meta.updatedAt}${eventTime}\nlinks: ${links}${nodeId}\n---\n\n${body}`
}

const parseNote = (raw: string): { meta: ZettelNote; body: string } => {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
  if (!match) throw new Error('Invalid note format: missing frontmatter')
  const fm = match[1]!
  const body = match[2]!.trim()

  const get = (key: string): string => {
    const m = fm.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'))
    return m?.[1]?.trim() ?? ''
  }
  const getArr = (key: string): string[] => {
    const m = fm.match(new RegExp(`^${key}:\\s*\\[(.*)\\]$`, 'm'))
    if (!m?.[1]?.trim()) return []
    return m[1].split(',').map(s => s.trim()).filter(Boolean)
  }

  const parseLinks = (): ZettelLink[] =>
    getArr('links').map(entry => {
      const colon = entry.indexOf(':')
      if (colon > 0) {
        const type = entry.slice(0, colon) as ZettelLinkType
        const name = entry.slice(colon + 1)
        return { name, type: ZETTEL_LINK_TYPES.includes(type) ? type : 'supports' }
      }
      // Legacy: untyped entry — default to 'supports'
      return { name: entry, type: 'supports' as ZettelLinkType }
    })

  const id = get('id')
  const rawNodeId = get('kgraphNodeId')
  return {
    meta: {
      id,
      name: get('name'),
      synopsis: get('synopsis'),
      tags: getArr('tags'),
      createdAt: get('createdAt'),
      updatedAt: get('updatedAt'),
      eventTime: get('eventTime') || undefined,
      path: `notes/${id}.md`,
      links: parseLinks(),
      kgraphNodeId: rawNodeId ? Number(rawNodeId) : undefined,
    },
    body,
  }
}

// ─── kgraph helper ───

const upsertInKgraph = async (
  kgraphRef: ActorRef<KgraphMsg>,
  userId: string,
  kgraphNodeId: number | undefined,
  name: string,
  synopsis: string,
  tags: string[],
  log: any,
  eventTime?: string,
): Promise<number | undefined> => {
  const embeddingText = `${synopsis} ${tags.join(' ')}`

  if (kgraphNodeId !== undefined) {
    log.debug('zettel-notes: updating existing kgraph node', { userId, kgraphNodeId, name })
    await ask<KgraphMsg, ToolReply>(
      kgraphRef,
      (replyTo) => ({
        type: 'updateNode',
        nodeId: kgraphNodeId,
        properties: { name, description: synopsis, eventTime },
        embeddingText,
        userId,
        replyTo,
      }),
    )
    return kgraphNodeId
  }

  log.debug('zettel-notes: creating new kgraph node', { userId, name })
  const reply = await ask<KgraphMsg, ToolReply>(
    kgraphRef,
    (replyTo) => ({
      type: 'invoke',
      toolName: 'kgraph_create_node',
      arguments: JSON.stringify({ label: 'Note', name, properties: { description: synopsis, eventTime }, embeddingText, userId }),
      replyTo,
      userId,
    }),
  )

  if (reply.type !== 'toolResult') {
    if (reply.type === 'toolError') {
      log.warn('zettel-notes: kgraph create_node failed', { userId, name, error: reply.error })
    } else {
      log.warn('zettel-notes: unexpected long-running reply for kgraph create_node', { userId, name, jobId: reply.jobId })
    }
    return undefined
  }
  return (JSON.parse(reply.result.text) as { nodeId: number }).nodeId
}

// ─── Tool handlers ───

type IndexQueue = ReturnType<typeof makeIndexQueue>

const handleCreate = async (
  kgraphRef: ActorRef<KgraphMsg>,
  userId: string,
  args: Record<string, unknown>,
  queue: IndexQueue,
  dbPath: string,
  log: any,
): Promise<string> => {
  const name = args.name as string
  const synopsis = args.synopsis as string
  const content = args.content as string
  const tags = Array.isArray(args.tags) ? (args.tags as string[]) : []
  const eventTime = typeof args.eventTime === 'string' ? args.eventTime : undefined

  log.info('zettel-notes: creating note', { userId, name, tags })
  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  const slug = slugify(name)

  const kgraphNodeId = await upsertInKgraph(kgraphRef, userId, undefined, name, synopsis, tags, log, eventTime)

  const meta: ZettelNote = {
    id, name, synopsis, tags,
    createdAt: now, updatedAt: now,
    eventTime,
    path: `notes/${slug}-${id}.md`,
    links: [],
    kgraphNodeId,
  }

  await mkdir(`${getBasePath(userId, dbPath)}/notes`, { recursive: true })
  await Bun.write(noteFilePath(userId, meta, dbPath), serializeNote(meta, content))
  await queue.mutate(userId, (idx) => ({ notes: [...idx.notes, meta] }))

  return JSON.stringify({ id, name, synopsis, tags, createdAt: now, eventTime })
}

const handleUpdate = async (
  kgraphRef: ActorRef<KgraphMsg>,
  userId: string,
  args: Record<string, unknown>,
  queue: IndexQueue,
  dbPath: string,
  log: any,
): Promise<string> => {
  const id = args.id as string
  log.info('zettel-notes: updating note', { userId, id })

  const currentIndex = await queue.current(userId)
  const existingMeta = currentIndex.notes.find(n => n.id === id)
  if (!existingMeta) return JSON.stringify({ error: 'Note not found' })

  const raw = await Bun.file(noteFilePath(userId, existingMeta, dbPath)).text()
  const { body: existingBody } = parseNote(raw)

  const name = typeof args.name === 'string' ? args.name : existingMeta.name
  const synopsis = typeof args.synopsis === 'string' ? args.synopsis : existingMeta.synopsis
  const content = typeof args.content === 'string' ? args.content : existingBody
  const tags = Array.isArray(args.tags) ? (args.tags as string[]) : existingMeta.tags
  const eventTime = typeof args.eventTime === 'string' ? args.eventTime : existingMeta.eventTime
  const now = new Date().toISOString()

  const updated: ZettelNote = { ...existingMeta, name, synopsis, tags, eventTime, updatedAt: now }

  await Bun.write(noteFilePath(userId, existingMeta, dbPath), serializeNote(updated, content))
  await queue.mutate(userId, (idx) => ({ notes: idx.notes.map(n => n.id === id ? updated : n) }))
  await upsertInKgraph(kgraphRef, userId, existingMeta.kgraphNodeId, name, synopsis, tags, log, eventTime)

  return JSON.stringify({ id, name, synopsis, tags, updatedAt: now, eventTime })
}

const ZETTEL_SEARCH_TOP_N = 8

const handleSearch = async (
  kgraphRef: ActorRef<KgraphMsg>,
  userId: string,
  args: Record<string, unknown>,
  queue: IndexQueue,
  dbPath: string,
  log: any,
): Promise<string> => {
  const text = args.text as string
  const filterTags = Array.isArray(args.tags) ? (args.tags as string[]) : []
  const before = typeof args.before === 'string' ? args.before : undefined
  const after = typeof args.after === 'string' ? args.after : undefined
  const timeProperty = (typeof args.timeProperty === 'string' ? args.timeProperty : 'eventTime') as string
  const queryText = filterTags.length > 0 ? `${text} ${filterTags.join(' ')}` : text
  log.info('zettel-notes: semantic search', { userId, text: text.slice(0, 50) + '...' })

  const filter = (before || after) ? { before, after, property: timeProperty } : undefined

  const reply = await ask<KgraphMsg, VectorSearchReply>(
    kgraphRef,
    (replyTo) => ({ type: 'vectorSearch', label: 'Note', text: queryText, topN: ZETTEL_SEARCH_TOP_N, userId, replyTo, filter }),
  )

  const index = await queue.current(userId)

  const readContent = async (note: ZettelNote): Promise<string> => {
    try {
      const raw = await Bun.file(noteFilePath(userId, note, dbPath)).text()
      return parseNote(raw).body
    } catch { return '' }
  }

  const noteToResult = async (note: ZettelNote, score: number) => ({
    id: note.id, name: note.name, synopsis: note.synopsis, tags: note.tags,
    links: note.links, content: await readContent(note), score,
  })

  if (reply.type === 'vectorSearchError') {
    log.warn('zettel-notes: vector search failed, falling back to tag/recent notes', { userId, error: reply.error })
    const pool = filterTags.length > 0
      ? index.notes.filter(n => filterTags.every(t => n.tags.includes(t)))
      : index.notes.slice(-10)
    return JSON.stringify(await Promise.all(pool.map(n => noteToResult(n, 0))))
  }

  // Map kgraph matches to zettel notes
  const results = await Promise.all(
    reply.matches.map(async (m) => {
      const note = index.notes.find(n => n.kgraphNodeId === m.nodeId)
      if (!note) return null
      return noteToResult(note, Math.round(m.score * 1000) / 1000)
    })
  )

  const validResults = results.filter((r): r is NonNullable<typeof r> => r !== null)

  // Tag fallback: vector search found nothing
  if (validResults.length === 0 && filterTags.length > 0) {
    const tagMatches = index.notes.filter(n => filterTags.every(t => n.tags.includes(t)))
    log.debug('zettel-notes: tag fallback results', { userId, count: tagMatches.length })
    return JSON.stringify(await Promise.all(tagMatches.map(n => noteToResult(n, 0))))
  }

  log.debug('zettel-notes: search results', { userId, count: validResults.length })
  return JSON.stringify(validResults)
}

const handleLinks = async (
  userId: string,
  args: Record<string, unknown>,
  queue: IndexQueue,
  dbPath: string,
  log: any,
): Promise<string> => {
  const index = await queue.current(userId)
  const note = typeof args.id === 'string'
    ? index.notes.find(n => n.id === args.id)
    : index.notes.find(n => n.name === args.name)

  log.debug('zettel-notes: links', { userId, id: args.id, name: args.name })
  if (!note) return JSON.stringify({ error: 'Note not found' })

  const linked = await Promise.all(
    note.links.flatMap(link => {
      const target = index.notes.find(n => n.name === link.name)
      if (!target) return []
      return [
        (async () => {
          try {
            const raw = await Bun.file(noteFilePath(userId, target, dbPath)).text()
            const { body } = parseNote(raw)
            return { id: target.id, name: target.name, linkType: link.type, synopsis: target.synopsis, tags: target.tags, links: target.links, content: body }
          } catch {
            return { id: target.id, name: target.name, linkType: link.type, synopsis: target.synopsis, tags: target.tags, links: target.links, content: '' }
          }
        })(),
      ]
    })
  )
  return JSON.stringify(linked)
}

const handleUnlinkedNotes = async (
  userId: string,
  queue: IndexQueue,
  log: any,
): Promise<string> => {
  const index = await queue.current(userId)
  log.info('zettel-notes: fetching unlinked notes', { userId })

  const incomingCount = new Map<string, number>()
  for (const note of index.notes) {
    for (const link of note.links) {
      incomingCount.set(link.name, (incomingCount.get(link.name) || 0) + 1)
    }
  }

  const noIncoming = index.notes.filter(n => (incomingCount.get(n.name) || 0) === 0)
  const noOutgoing = index.notes.filter(n => n.links.length === 0)
  const singleOutgoing = index.notes.filter(n => n.links.length === 1)

  // Combine and deduplicate
  const resultIds = new Set([
    ...noIncoming.map(n => n.id),
    ...noOutgoing.map(n => n.id),
    ...singleOutgoing.map(n => n.id)
  ])
  const results = index.notes
    .filter(n => resultIds.has(n.id))
    .map(n => ({
      id: n.id,
      name: n.name,
      synopsis: n.synopsis,
      tags: n.tags,
      incomingLinks: incomingCount.get(n.name) || 0,
      outgoingLinks: n.links.length,
    }))

  return JSON.stringify(results)
}

const handleLink = async (
  kgraphRef: ActorRef<KgraphMsg>,
  userId: string,
  args: Record<string, unknown>,
  queue: IndexQueue,
  dbPath: string,
  log: any,
): Promise<string> => {
  const index = await queue.current(userId)

  const source = typeof args.sourceId === 'string'
    ? index.notes.find(n => n.id === args.sourceId)
    : index.notes.find(n => n.name === args.sourceName)
  if (!source) return JSON.stringify({ error: 'Source note not found' })

  const target = typeof args.targetId === 'string'
    ? index.notes.find(n => n.id === args.targetId)
    : index.notes.find(n => n.name === args.targetName)
  if (!target) return JSON.stringify({ error: 'Target note not found' })

  const rawLinkType = typeof args.linkType === 'string' ? args.linkType : 'supports'
  const linkType: ZettelLinkType = ZETTEL_LINK_TYPES.includes(rawLinkType as ZettelLinkType)
    ? (rawLinkType as ZettelLinkType)
    : 'supports'

  if (source.links.some(l => l.name === target.name && l.type === linkType)) {
    return JSON.stringify({ ok: true, message: 'Link already exists' })
  }

  const updatedLinks: ZettelLink[] = [...source.links, { name: target.name, type: linkType }]
  const now = new Date().toISOString()
  const updated: ZettelNote = { ...source, links: updatedLinks, updatedAt: now }

  const raw = await Bun.file(noteFilePath(userId, source, dbPath)).text()
  const { body } = parseNote(raw)
  await Bun.write(noteFilePath(userId, source, dbPath), serializeNote(updated, body))
  await queue.mutate(userId, (idx) => ({ notes: idx.notes.map(n => n.id === source.id ? updated : n) }))

  const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  const rel = linkType.toUpperCase()
  const statement =
    `MATCH (a:Note {name:"${esc(source.name)}"}), (b:Note {name:"${esc(target.name)}"}) ` +
    `MERGE (a)-[:${rel}]->(b)`
  await ask<KgraphMsg, ToolReply>(
    kgraphRef,
    (replyTo) => ({ type: 'invoke', toolName: 'kgraph_create_link', arguments: JSON.stringify({ statement, userId }), replyTo, userId }),
  ).catch(() => { })

  log.info('zettel-notes: linked notes', { userId, source: source.name, target: target.name, type: linkType })
  return JSON.stringify({ ok: true, source: source.name, target: target.name, type: linkType })
}

// ─── Actor definition ───

export const ZettelNotes = (kgraphRef: ActorRef<KgraphMsg>, dbPath: string): ActorDef<ZettelNoteMsg, ZettelState> => {
  const queue = makeIndexQueue(dbPath)

  return {
    initialState: () => ({ kgraphRef, dbPath }),
    lifecycle: onLifecycle({
      start: (_state) => ({ state: { kgraphRef, dbPath } }),
    }),

    handler: onMessage<ZettelNoteMsg, ZettelState>({
      invoke: (state, msg, ctx) => {
        const { toolName, arguments: rawArgs, replyTo } = msg
        const userId = msg.userId

        const runTool = async (): Promise<string> => {
          const args = JSON.parse(rawArgs) as Record<string, unknown>
          const effectiveUserId = (args.userId as string | undefined) ?? userId
          switch (toolName) {
            case zettelCreateTool.name: return handleCreate(state.kgraphRef, effectiveUserId, args, queue, state.dbPath, ctx.log)
            case zettelUpdateTool.name: return handleUpdate(state.kgraphRef, effectiveUserId, args, queue, state.dbPath, ctx.log)
            case zettelSearchTool.name: return handleSearch(state.kgraphRef, effectiveUserId, args, queue, state.dbPath, ctx.log)
            case zettelLinksTool.name:  return handleLinks(effectiveUserId, args, queue, state.dbPath, ctx.log)
            case zettelUnlinkedTool.name: return handleUnlinkedNotes(effectiveUserId, queue, ctx.log)
            case zettelLinkTool.name:  return handleLink(state.kgraphRef, effectiveUserId, args, queue, state.dbPath, ctx.log)
            default: throw new Error(`Unknown tool: ${toolName}`)
          }
        }

        ctx.pipeToSelf(
          runTool(),
          (result) => ({ type: '_done'  as const, replyTo, result }),
          (error)  => ({ type: '_error' as const, replyTo, error: String(error) }),
        )

        return { state }
      },

      _done: (state, msg) => {
        msg.replyTo.send({ type: 'toolResult', result: { text: msg.result } })
        return { state }
      },

      _error: (state, msg, ctx) => {
        ctx.log.error('zettel-notes error', { error: msg.error })
        msg.replyTo.send({ type: 'toolError', error: msg.error })
        return { state }
      },
    }),
  }
}
