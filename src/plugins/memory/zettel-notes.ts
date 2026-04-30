import { mkdir } from 'node:fs/promises'
import type { ActorDef, ActorRef } from '../../system/types.ts'
import { onLifecycle, onMessage } from '../../system/match.ts'
import { ask } from '../../system/ask.ts'
import type { ToolInvokeMsg, ToolReply, ToolSchema } from '../../types/tools.ts'
import type { KgraphMsg, ZettelNote, ZettelIndex, VectorSearchReply } from './types.ts'

// ─── Tool names ───

export const ZETTEL_CREATE_TOOL   = 'zettel_create'
export const ZETTEL_UPDATE_TOOL   = 'zettel_update'
export const ZETTEL_READ_TOOL     = 'zettel_read'
export const ZETTEL_LIST_TOOL     = 'zettel_list'
export const ZETTEL_SEARCH_TOOL   = 'zettel_search'
export const ZETTEL_LINKS_TOOL    = 'zettel_links'

// ─── Tool schemas ───

export const ZETTEL_CREATE_SCHEMA: ToolSchema = {
  type: 'function',
  function: {
    name: ZETTEL_CREATE_TOOL,
    description: 'Create a new atomic Zettelkasten note capturing a self-contained unit of knowledge.',
    parameters: {
      type: 'object',
      properties: {
        name:     { type: 'string', description: 'Short note title (2-5 words, Title Case).' },
        synopsis: { type: 'string', description: "One sentence summary of this note's content. Used for semantic search." },
        content:  { type: 'string', description: 'Full markdown content. Use [[Note Title]] wiki-links to reference related notes.' },
        tags:     { type: 'array', items: { type: 'string' }, description: 'Lowercase tags e.g. ["typescript", "work", "preference"].' },
        userId:   { type: 'string' },
      },
      required: ['name', 'synopsis', 'content', 'tags'],
    },
  },
}

export const ZETTEL_UPDATE_SCHEMA: ToolSchema = {
  type: 'function',
  function: {
    name: ZETTEL_UPDATE_TOOL,
    description: 'Update an existing Zettelkasten note. Only pass fields that should change. Re-embeds with fresh synopsis.',
    parameters: {
      type: 'object',
      properties: {
        id:       { type: 'string', description: 'Note UUID.' },
        name:     { type: 'string', description: 'Updated title (optional).' },
        synopsis: { type: 'string', description: 'Updated one-sentence summary (optional).' },
        content:  { type: 'string', description: 'Full updated markdown content (optional).' },
        tags:     { type: 'array', items: { type: 'string' }, description: 'Updated tags (optional).' },
        userId:   { type: 'string' },
      },
      required: ['id'],
    },
  },
}

export const ZETTEL_READ_SCHEMA: ToolSchema = {
  type: 'function',
  function: {
    name: ZETTEL_READ_TOOL,
    description: 'Read a Zettelkasten note by id or name. Returns metadata and full content.',
    parameters: {
      type: 'object',
      properties: {
        id:     { type: 'string', description: 'Note UUID.' },
        name:   { type: 'string', description: 'Note title (used if id is not provided).' },
        userId: { type: 'string' },
      },
    },
  },
}

export const ZETTEL_LIST_SCHEMA: ToolSchema = {
  type: 'function',
  function: {
    name: ZETTEL_LIST_TOOL,
    description: 'List Zettelkasten note metadata. Optionally filter by tags (must match ALL provided tags).',
    parameters: {
      type: 'object',
      properties: {
        tags:   { type: 'array', items: { type: 'string' }, description: 'Filter notes that have ALL of these tags.' },
        userId: { type: 'string' },
      },
    },
  },
}

export const ZETTEL_SEARCH_SCHEMA: ToolSchema = {
  type: 'function',
  function: {
    name: ZETTEL_SEARCH_TOOL,
    description: 'Semantic search via vector embeddings with graph expansion. Finds notes similar to the given text, expands results via wiki-links, and re-ranks by combined similarity + graph proximity score. Optional tags enrich the vector query and serve as a fallback filter if no results are found. Returns up to 8 notes with full content and links — no need to call zettel_read afterwards.',
    parameters: {
      type: 'object',
      properties: {
        text:   { type: 'string', description: 'One-sentence synopsis of the topic to search for. Must be a declarative summary, not a question — this aligns with how note embeddings are stored.' },
        tags:   { type: 'array', items: { type: 'string' }, description: 'Optional tags to enrich the vector query and filter results when vector search finds nothing. Must match ALL provided tags.' },
        userId: { type: 'string' },
      },
      required: ['text'],
    },
  },
}

export const ZETTEL_LINKS_SCHEMA: ToolSchema = {
  type: 'function',
  function: {
    name: ZETTEL_LINKS_TOOL,
    description: 'Return the notes linked from a given note. Returns id, name, synopsis, tags, links, and full content for each linked note that exists.',
    parameters: {
      type: 'object',
      properties: {
        id:     { type: 'string', description: 'Note UUID.' },
        name:   { type: 'string', description: 'Note title (used if id is not provided).' },
        userId: { type: 'string' },
      },
    },
  },
}

export const ZETTEL_LINK_TOOL   = 'zettel_link'

export const ZETTEL_LINK_SCHEMA: ToolSchema = {
  type: 'function',
  function: {
    name: ZETTEL_LINK_TOOL,
    description: 'Create a directional link from one Zettelkasten note to another. Updates the source note links metadata and the knowledge graph. Both notes must already exist.',
    parameters: {
      type: 'object',
      properties: {
        sourceId:   { type: 'string', description: 'UUID of the source note.' },
        sourceName: { type: 'string', description: 'Title of the source note (used if sourceId not provided).' },
        targetId:   { type: 'string', description: 'UUID of the target note.' },
        targetName: { type: 'string', description: 'Title of the target note (used if targetId not provided).' },
        userId:     { type: 'string' },
      },
    },
  },
}

// ─── State & messages ───

type ZettelState = { kgraphRef: ActorRef<KgraphMsg>; dbPath: string } | null

export type ZettelNoteMsg =
  | ToolInvokeMsg
  | { type: '_done';  replyTo: ActorRef<ToolReply>; result: string }
  | { type: '_error'; replyTo: ActorRef<ToolReply>; error: string }

// ─── File helpers ───

const slugify = (name: string): string =>
  name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

const getBasePath = (userId: string, dbPath: string) => `${dbPath}/${userId}`

const indexPath    = (userId: string, dbPath: string) => `${getBasePath(userId, dbPath)}/notes/index.json`
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
  const tags  = meta.tags.length  > 0 ? `[${meta.tags.join(', ')}]`  : '[]'
  const links = meta.links.length > 0 ? `[${meta.links.join(', ')}]` : '[]'
  const nodeId = meta.kgraphNodeId !== undefined ? `\nkgraphNodeId: ${meta.kgraphNodeId}` : ''
  return `---\nid: ${meta.id}\nname: ${meta.name}\nsynopsis: ${meta.synopsis}\ntags: ${tags}\ncreatedAt: ${meta.createdAt}\nupdatedAt: ${meta.updatedAt}\nlinks: ${links}${nodeId}\n---\n\n${body}`
}

const parseNote = (raw: string): { meta: ZettelNote; body: string } => {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
  if (!match) throw new Error('Invalid note format: missing frontmatter')
  const fm   = match[1]!
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

  const id = get('id')
  const rawNodeId = get('kgraphNodeId')
  return {
    meta: {
      id,
      name:          get('name'),
      synopsis:      get('synopsis'),
      tags:          getArr('tags'),
      createdAt:     get('createdAt'),
      updatedAt:     get('updatedAt'),
      path:          `notes/${id}.md`,
      links:         getArr('links'),
      kgraphNodeId:  rawNodeId ? Number(rawNodeId) : undefined,
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
): Promise<number | undefined> => {
  const embeddingText = `${name} ${tags.join(' ')} ${synopsis}`

  if (kgraphNodeId !== undefined) {
    log.debug('zettel-notes: updating existing kgraph node', { userId, kgraphNodeId, name })
    await ask<KgraphMsg, ToolReply>(
      kgraphRef,
      (replyTo) => ({
        type: 'updateNode',
        nodeId: kgraphNodeId,
        properties: { name, description: synopsis },
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
      arguments: JSON.stringify({ label: 'Note', name, properties: { description: synopsis }, embeddingText, userId }),
      replyTo,
      userId,
    }),
  )

  if (reply.type === 'toolError') {
    log.warn('zettel-notes: kgraph create_node failed', { userId, name, error: reply.error })
    return undefined
  }
  return (JSON.parse(reply.result) as { nodeId: number }).nodeId
}

const linkNotesInKgraph = async (
  kgraphRef: ActorRef<KgraphMsg>,
  userId: string,
  sourceCanonical: string,
  linkTargets: string[],
  index: ZettelIndex,
  log: any,
): Promise<void> => {
  const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')

  for (const targetName of linkTargets) {
    if (!index.notes.some(n => n.name === targetName)) continue  // target not created yet

    log.debug('zettel-notes: linking in kgraph', { userId, source: sourceCanonical, target: targetName })
    const statement =
      `MATCH (a:Note {name:"${esc(sourceCanonical)}"}), (b:Note {name:"${esc(targetName)}"}) ` +
      `MERGE (a)-[:LINKS_TO]->(b)`

    await ask<KgraphMsg, ToolReply>(
      kgraphRef,
      (replyTo) => ({
        type: 'invoke',
        toolName: 'kgraph_create_link',
        arguments: JSON.stringify({ statement, userId }),
        replyTo,
        userId,
      }),
    ).catch(() => {})  // best-effort: link may fail if canonical names diverged
  }
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
  const name     = args.name as string
  const synopsis = args.synopsis as string
  const content  = args.content as string
  const tags     = Array.isArray(args.tags) ? (args.tags as string[]) : []

  log.info('zettel-notes: creating note', { userId, name, tags })
  const id   = crypto.randomUUID()
  const now  = new Date().toISOString()
  const slug = slugify(name)

  const kgraphNodeId = await upsertInKgraph(kgraphRef, userId, undefined, name, synopsis, tags, log)

  const meta: ZettelNote = {
    id, name, synopsis, tags,
    createdAt: now, updatedAt: now,
    path: `notes/${slug}-${id}.md`,
    links: [],
    kgraphNodeId,
  }

  await mkdir(`${getBasePath(userId, dbPath)}/notes`, { recursive: true })
  await Bun.write(noteFilePath(userId, meta, dbPath), serializeNote(meta, content))
  await queue.mutate(userId, (idx) => ({ notes: [...idx.notes, meta] }))

  return JSON.stringify({ id, name, synopsis, tags, createdAt: now })
}

const handleUpdate = async (
  kgraphRef: ActorRef<KgraphMsg>,
  userId: string,
  args: Record<string, unknown>,
  queue: IndexQueue,
  dbPath: string,
  log: any,
): Promise<string> => {
  const id  = args.id as string
  log.info('zettel-notes: updating note', { userId, id })

  const currentIndex = await queue.current(userId)
  const existingMeta = currentIndex.notes.find(n => n.id === id)
  if (!existingMeta) return JSON.stringify({ error: 'Note not found' })

  const raw = await Bun.file(noteFilePath(userId, existingMeta, dbPath)).text()
  const { body: existingBody } = parseNote(raw)

  const name     = typeof args.name     === 'string' ? args.name     : existingMeta.name
  const synopsis = typeof args.synopsis === 'string' ? args.synopsis : existingMeta.synopsis
  const content  = typeof args.content  === 'string' ? args.content  : existingBody
  const tags     = Array.isArray(args.tags) ? (args.tags as string[]) : existingMeta.tags
  const now      = new Date().toISOString()

  const updated: ZettelNote = { ...existingMeta, name, synopsis, tags, updatedAt: now }

  await Bun.write(noteFilePath(userId, existingMeta, dbPath), serializeNote(updated, content))
  await queue.mutate(userId, (idx) => ({ notes: idx.notes.map(n => n.id === id ? updated : n) }))
  await upsertInKgraph(kgraphRef, userId, existingMeta.kgraphNodeId, name, synopsis, tags, log)

  return JSON.stringify({ id, name, synopsis, tags, updatedAt: now })
}

const handleRead = async (
  userId: string,
  args: Record<string, unknown>,
  queue: IndexQueue,
  dbPath: string,
  log: any,
): Promise<string> => {
  let noteId = typeof args.id === 'string' ? args.id : undefined

  if (!noteId && typeof args.name === 'string') {
    const index = await queue.current(userId)
    noteId = index.notes.find(n => n.name === args.name)?.id
  }

  log.debug('zettel-notes: reading note', { userId, id: noteId, name: args.name })
  if (!noteId) return JSON.stringify({ error: 'Note not found' })

  const index    = await queue.current(userId)
  const noteMeta = index.notes.find(n => n.id === noteId)
  if (!noteMeta) return JSON.stringify({ error: `Note ${noteId} not found` })

  try {
    const raw    = await Bun.file(noteFilePath(userId, noteMeta, dbPath)).text()
    const { body } = parseNote(raw)
    return JSON.stringify({ ...noteMeta, content: body })
  } catch {
    return JSON.stringify({ error: `Note ${noteId} not found` })
  }
}

const handleList = async (
  userId: string,
  args: Record<string, unknown>,
  queue: IndexQueue,
  log: any,
): Promise<string> => {
  const filterTags = Array.isArray(args.tags) ? (args.tags as string[]) : []
  log.debug('zettel-notes: listing notes', { userId, filterTags })
  const index = await queue.current(userId)

  const notes = filterTags.length > 0
    ? index.notes.filter(n => filterTags.every(t => n.tags.includes(t)))
    : index.notes

  return JSON.stringify(notes.map(({ id, name, synopsis, tags, createdAt, updatedAt }) =>
    ({ id, name, synopsis, tags, createdAt, updatedAt })))
}

const SEARCH_DISTANCE_THRESHOLD = 0.4
const SEARCH_TOP_N              = 5
const SEARCH_MAX_RESULTS        = 8
const SEARCH_VECTOR_WEIGHT      = 0.7
const SEARCH_GRAPH_WEIGHT       = 0.3

const handleSearch = async (
  kgraphRef: ActorRef<KgraphMsg>,
  userId: string,
  args: Record<string, unknown>,
  queue: IndexQueue,
  dbPath: string,
  log: any,
): Promise<string> => {
  const text       = args.text as string
  const filterTags = Array.isArray(args.tags) ? (args.tags as string[]) : []
  const queryText  = filterTags.length > 0 ? `${text} ${filterTags.join(' ')}` : text
  log.info('zettel-notes: semantic search', { userId, text: text.slice(0, 50) + '...' })

  const reply = await ask<KgraphMsg, VectorSearchReply>(
    kgraphRef,
    (replyTo) => ({ type: 'vectorSearch', label: 'Note', text: queryText, topN: SEARCH_TOP_N, userId, replyTo }),
  )

  const index = await queue.current(userId)

  const readContent = async (note: ZettelNote): Promise<string> => {
    try {
      const raw = await Bun.file(noteFilePath(userId, note, dbPath)).text()
      return parseNote(raw).body
    } catch { return '' }
  }

  const noteToResult = async (note: ZettelNote) => ({
    id: note.id, name: note.name, synopsis: note.synopsis, tags: note.tags,
    links: note.links, content: await readContent(note),
  })

  if (reply.type === 'vectorSearchError') {
    log.warn('zettel-notes: vector search failed, falling back to tag/recent notes', { userId, error: reply.error })
    const pool = filterTags.length > 0
      ? index.notes.filter(n => filterTags.every(t => n.tags.includes(t)))
      : index.notes.slice(-10)
    return JSON.stringify(await Promise.all(pool.map(noteToResult)))
  }

  // Step 1: seed notes from vector search, filtered by threshold
  const seedMatches = reply.matches.filter(m => m.distance <= SEARCH_DISTANCE_THRESHOLD)
  const seedNoteIds = new Set<string>()

  type Candidate = { note: ZettelNote; distance: number; graphProximity: number }
  const candidates = new Map<string, Candidate>()

  for (const m of seedMatches) {
    const note = index.notes.find(n => n.kgraphNodeId === m.nodeId)
    if (!note) continue
    seedNoteIds.add(note.id)
    candidates.set(note.id, { note, distance: m.distance, graphProximity: 1.0 })
  }

  // Tag fallback: vector search found nothing above threshold
  if (candidates.size === 0 && filterTags.length > 0) {
    const tagMatches = index.notes.filter(n => filterTags.every(t => n.tags.includes(t)))
    log.debug('zettel-notes: tag fallback results', { userId, count: tagMatches.length })
    return JSON.stringify(await Promise.all(tagMatches.map(noteToResult)))
  }

  // Step 2: expand 1 hop via wiki-links from each seed
  for (const id of seedNoteIds) {
    const seed = candidates.get(id)!.note
    for (const linkName of seed.links) {
      const neighbour = index.notes.find(n => n.name === linkName)
      if (!neighbour || candidates.has(neighbour.id)) continue
      candidates.set(neighbour.id, { note: neighbour, distance: 1.0, graphProximity: 0.5 })
    }
  }

  // Step 3: re-rank by blended score and take top N
  const ranked = [...candidates.values()]
    .map(c => ({
      note:  c.note,
      score: Math.round((SEARCH_VECTOR_WEIGHT * (1 - c.distance) + SEARCH_GRAPH_WEIGHT * c.graphProximity) * 1000) / 1000,
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, SEARCH_MAX_RESULTS)

  // Step 4: load full content for each result
  const results = await Promise.all(
    ranked.map(async ({ note, score }) => ({ ...await noteToResult(note), score }))
  )

  log.debug('zettel-notes: search results', { userId, count: results.length })
  return JSON.stringify(results)
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
    note.links.flatMap(linkName => {
      const target = index.notes.find(n => n.name === linkName)
      if (!target) return []
      return [
        (async () => {
          try {
            const raw = await Bun.file(noteFilePath(userId, target, dbPath)).text()
            const { body } = parseNote(raw)
            return { id: target.id, name: target.name, synopsis: target.synopsis, tags: target.tags, links: target.links, content: body }
          } catch {
            return { id: target.id, name: target.name, synopsis: target.synopsis, tags: target.tags, links: target.links, content: '' }
          }
        })(),
      ]
    })
  )
  return JSON.stringify(linked)
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

  if (source.links.includes(target.name)) {
    return JSON.stringify({ ok: true, message: 'Link already exists' })
  }

  const updatedLinks = [...source.links, target.name]
  const now = new Date().toISOString()
  const updated: ZettelNote = { ...source, links: updatedLinks, updatedAt: now }

  const raw = await Bun.file(noteFilePath(userId, source, dbPath)).text()
  const { body } = parseNote(raw)
  await Bun.write(noteFilePath(userId, source, dbPath), serializeNote(updated, body))
  await queue.mutate(userId, (idx) => ({ notes: idx.notes.map(n => n.id === source.id ? updated : n) }))

  const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  const statement =
    `MATCH (a:Note {name:"${esc(source.name)}"}), (b:Note {name:"${esc(target.name)}"}) ` +
    `MERGE (a)-[:LINKS_TO]->(b)`
  await ask<KgraphMsg, ToolReply>(
    kgraphRef,
    (replyTo) => ({ type: 'invoke', toolName: 'kgraph_create_link', arguments: JSON.stringify({ statement, userId }), replyTo, userId }),
  ).catch(() => {})

  log.info('zettel-notes: linked notes', { userId, source: source.name, target: target.name })
  return JSON.stringify({ ok: true, source: source.name, target: target.name })
}

// ─── Actor definition ───

export const createZettelNotesActor = (kgraphRef: ActorRef<KgraphMsg>, dbPath: string): ActorDef<ZettelNoteMsg, ZettelState> => {
  const queue = makeIndexQueue(dbPath)

  return {
  lifecycle: onLifecycle({
    start: (_state) => ({ state: { kgraphRef, dbPath } }),
  }),

  handler: onMessage<ZettelNoteMsg, ZettelState>({
    invoke: (state, msg, ctx) => {
      if (!state) {
        msg.replyTo.send({ type: 'toolError', error: 'zettel-notes not ready' })
        return { state }
      }

      const { toolName, arguments: rawArgs, replyTo } = msg
      const userId = msg.userId

      ctx.pipeToSelf(
        (async () => {
          const args = JSON.parse(rawArgs) as Record<string, unknown>
          const effectiveUserId = (args.userId as string | undefined) ?? userId
          switch (toolName) {
            case ZETTEL_CREATE_TOOL:   return handleCreate(state.kgraphRef, effectiveUserId, args, queue, state.dbPath, ctx.log)
            case ZETTEL_UPDATE_TOOL:   return handleUpdate(state.kgraphRef, effectiveUserId, args, queue, state.dbPath, ctx.log)
            case ZETTEL_READ_TOOL:     return handleRead(effectiveUserId, args, queue, state.dbPath, ctx.log)
            case ZETTEL_LIST_TOOL:     return handleList(effectiveUserId, args, queue, ctx.log)
            case ZETTEL_SEARCH_TOOL:   return handleSearch(state.kgraphRef, effectiveUserId, args, queue, state.dbPath, ctx.log)
            case ZETTEL_LINKS_TOOL:    return handleLinks(effectiveUserId, args, queue, state.dbPath, ctx.log)
            case ZETTEL_LINK_TOOL:    return handleLink(state.kgraphRef, effectiveUserId, args, queue, state.dbPath, ctx.log)
            default: throw new Error(`Unknown tool: ${toolName}`)
          }
        })(),
        (result) => ({ type: '_done'  as const, replyTo, result }),
        (error)  => ({ type: '_error' as const, replyTo, error: String(error) }),
      )

      return { state }
    },

    _done: (state, msg) => {
      msg.replyTo.send({ type: 'toolResult', result: msg.result })
      return { state }
    },

    _error: (state, msg, ctx) => {
      ctx.log.error('zettel-notes error', { error: msg.error })
      msg.replyTo.send({ type: 'toolError', error: msg.error })
      return { state }
    },
  }),
}}
