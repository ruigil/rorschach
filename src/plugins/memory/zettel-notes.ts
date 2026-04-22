import { mkdir } from 'node:fs/promises'
import type { ActorDef, ActorRef } from '../../system/types.ts'
import { onLifecycle, onMessage } from '../../system/match.ts'
import { ask } from '../../system/ask.ts'
import type { ToolInvokeMsg, ToolReply, ToolSchema } from '../../types/tools.ts'
import type { KgraphMsg, ZettelNote, ZettelIndex, VectorSearchReply } from '../../types/memory.ts'

// ─── Tool names ───

export const ZETTEL_CREATE_TOOL   = 'zettel_create'
export const ZETTEL_UPDATE_TOOL   = 'zettel_update'
export const ZETTEL_READ_TOOL     = 'zettel_read'
export const ZETTEL_LIST_TOOL     = 'zettel_list'
export const ZETTEL_SEARCH_TOOL   = 'zettel_search'
export const ZETTEL_ACTIVATE_TOOL = 'zettel_activate'

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
    description: 'Full-text search across all Zettelkasten note names, synopses, tags, and content.',
    parameters: {
      type: 'object',
      properties: {
        query:  { type: 'string', description: 'Search string.' },
        userId: { type: 'string' },
      },
      required: ['query'],
    },
  },
}

export const ZETTEL_ACTIVATE_SCHEMA: ToolSchema = {
  type: 'function',
  function: {
    name: ZETTEL_ACTIVATE_TOOL,
    description: 'Semantic search via vector embeddings — find notes most similar to the given text. Returns up to 5 matching notes with id, name, synopsis, tags. Use this first before reading or updating notes.',
    parameters: {
      type: 'object',
      properties: {
        text:   { type: 'string', description: 'Topic or summary text to search for semantically similar notes.' },
        userId: { type: 'string' },
      },
      required: ['text'],
    },
  },
}

// ─── State & messages ───

type ZettelState = { kgraphRef: ActorRef<KgraphMsg> } | null

export type ZettelNoteMsg =
  | ToolInvokeMsg
  | { type: '_done';  replyTo: ActorRef<ToolReply>; result: string }
  | { type: '_error'; replyTo: ActorRef<ToolReply>; error: string }

// ─── File helpers ───

const indexPath = (userId: string) => `workspace/memory/${userId}/notes/index.json`
const notePath  = (userId: string, id: string) => `workspace/memory/${userId}/notes/${id}.md`

// ─── Serialized index mutation queue ───
//
// Multiple concurrent pipeToSelf calls would each read the same stale index.json
// and overwrite each other. Chaining mutations through a per-userId promise queue
// ensures each operation sees the result of the previous one without re-reading disk.

const makeIndexQueue = () => {
  const queues = new Map<string, Promise<ZettelIndex>>()

  const current = (userId: string): Promise<ZettelIndex> =>
    (queues.get(userId) ?? readIndex(userId)).catch(() => readIndex(userId))

  const mutate = (userId: string, fn: (idx: ZettelIndex) => ZettelIndex): Promise<ZettelIndex> => {
    const next = current(userId).then(async (idx) => {
      const updated = fn(idx)
      await writeIndex(userId, updated)
      return updated
    })
    queues.set(userId, next.catch(() => readIndex(userId)))
    return next
  }

  return { current, mutate }
}

const readIndex = async (userId: string): Promise<ZettelIndex> => {
  try {
    const text = await Bun.file(indexPath(userId)).text()
    return JSON.parse(text) as ZettelIndex
  } catch {
    return { notes: [] }
  }
}

const writeIndex = async (userId: string, index: ZettelIndex): Promise<void> => {
  await mkdir(`workspace/memory/${userId}/notes`, { recursive: true })
  await Bun.write(indexPath(userId), JSON.stringify(index, null, 2))
}

const serializeNote = (meta: ZettelNote, body: string): string => {
  const tags  = meta.tags.length  > 0 ? `[${meta.tags.join(', ')}]`  : '[]'
  const links = meta.links.length > 0 ? `[${meta.links.join(', ')}]` : '[]'
  return `---\nid: ${meta.id}\nname: ${meta.name}\nsynopsis: ${meta.synopsis}\ntags: ${tags}\ncreatedAt: ${meta.createdAt}\nupdatedAt: ${meta.updatedAt}\nlinks: ${links}\n---\n\n${body}`
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
  return {
    meta: {
      id,
      name:      get('name'),
      synopsis:  get('synopsis'),
      tags:      getArr('tags'),
      createdAt: get('createdAt'),
      updatedAt: get('updatedAt'),
      path:      `notes/${id}.md`,
      links:     getArr('links'),
    },
    body,
  }
}

const extractLinks = (content: string): string[] => {
  const matches = content.matchAll(/\[\[([^\]]+)\]\]/g)
  const links: string[] = []
  for (const m of matches) {
    links.push(m[1]!)
  }
  return links
}

// ─── kgraph helper ───

const upsertInKgraph = async (
  kgraphRef: ActorRef<KgraphMsg>,
  userId: string,
  id: string,
  name: string,
  synopsis: string,
  tags: string[],
  log: any,
): Promise<string> => {
  const embeddingText = `${name} ${tags.join(' ')} ${synopsis}`
  const description   = `noteId:${id}\n${synopsis}`

  log.debug('zettel-notes: upserting into kgraph', { userId, name })
  const reply = await ask<KgraphMsg, ToolReply>(
    kgraphRef,
    (replyTo) => ({
      type: 'invoke',
      toolName: 'kgraph_upsert',
      arguments: JSON.stringify({ label: 'Note', name, properties: { description }, embeddingText, userId }),
      replyTo,
    }),
  )

  if (reply.type === 'toolError') throw new Error(`kgraph upsert failed: ${reply.error}`)
  return (JSON.parse(reply.result) as { canonicalName: string }).canonicalName
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
        toolName: 'kgraph_write',
        arguments: JSON.stringify({ statement, userId }),
        replyTo,
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
  log: any,
): Promise<string> => {
  const name     = args.name as string
  const synopsis = args.synopsis as string
  const content  = args.content as string
  const tags     = Array.isArray(args.tags) ? (args.tags as string[]) : []

  log.info('zettel-notes: creating note', { userId, name, tags })
  const id  = crypto.randomUUID()
  const now = new Date().toISOString()
  const meta: ZettelNote = {
    id, name, synopsis, tags,
    createdAt: now, updatedAt: now,
    path: `notes/${id}.md`,
    links: extractLinks(content),
  }

  await mkdir(`workspace/memory/${userId}/notes`, { recursive: true })
  await Bun.write(notePath(userId, id), serializeNote(meta, content))
  const index = await queue.mutate(userId, (idx) => ({ notes: [...idx.notes, meta] }))
  const canonical = await upsertInKgraph(kgraphRef, userId, id, name, synopsis, tags, log)
  await linkNotesInKgraph(kgraphRef, userId, canonical, meta.links, index, log)

  return JSON.stringify({ id, name, synopsis, tags, createdAt: now })
}

const handleUpdate = async (
  kgraphRef: ActorRef<KgraphMsg>,
  userId: string,
  args: Record<string, unknown>,
  queue: IndexQueue,
  log: any,
): Promise<string> => {
  const id  = args.id as string
  log.info('zettel-notes: updating note', { userId, id })
  const raw = await Bun.file(notePath(userId, id)).text()
  const { meta: existing, body: existingBody } = parseNote(raw)

  const name     = typeof args.name     === 'string' ? args.name     : existing.name
  const synopsis = typeof args.synopsis === 'string' ? args.synopsis : existing.synopsis
  const content  = typeof args.content  === 'string' ? args.content  : existingBody
  const tags     = Array.isArray(args.tags) ? (args.tags as string[]) : existing.tags
  const now      = new Date().toISOString()

  const updated: ZettelNote = { ...existing, name, synopsis, tags, updatedAt: now, links: extractLinks(content) }

  await Bun.write(notePath(userId, id), serializeNote(updated, content))
  const index = await queue.mutate(userId, (idx) => ({ notes: idx.notes.map(n => n.id === id ? updated : n) }))
  const canonical = await upsertInKgraph(kgraphRef, userId, id, name, synopsis, tags, log)
  await linkNotesInKgraph(kgraphRef, userId, canonical, updated.links, index, log)

  return JSON.stringify({ id, name, synopsis, tags, updatedAt: now })
}

const handleRead = async (
  userId: string,
  args: Record<string, unknown>,
  queue: IndexQueue,
  log: any,
): Promise<string> => {
  let noteId = typeof args.id === 'string' ? args.id : undefined

  if (!noteId && typeof args.name === 'string') {
    const index = await queue.current(userId)
    noteId = index.notes.find(n => n.name === args.name)?.id
  }

  log.debug('zettel-notes: reading note', { userId, id: noteId, name: args.name })
  if (!noteId) return JSON.stringify({ error: 'Note not found' })

  try {
    const raw = await Bun.file(notePath(userId, noteId)).text()
    const { meta, body } = parseNote(raw)
    return JSON.stringify({ ...meta, content: body })
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

const handleSearch = async (
  userId: string,
  args: Record<string, unknown>,
  queue: IndexQueue,
  log: any,
): Promise<string> => {
  const query = (args.query as string).toLowerCase()
  log.debug('zettel-notes: full-text search', { userId, query })
  const index = await queue.current(userId)
  const results: Array<{ id: string; name: string; synopsis: string; tags: string[] }> = []

  for (const note of index.notes) {
    if (
      note.name.toLowerCase().includes(query) ||
      note.synopsis.toLowerCase().includes(query) ||
      note.tags.some(t => t.includes(query))
    ) {
      results.push({ id: note.id, name: note.name, synopsis: note.synopsis, tags: note.tags })
      continue
    }
    try {
      const raw = await Bun.file(notePath(userId, note.id)).text()
      if (raw.toLowerCase().includes(query)) {
        results.push({ id: note.id, name: note.name, synopsis: note.synopsis, tags: note.tags })
      }
    } catch { /* skip unreadable notes */ }
  }

  return JSON.stringify(results)
}

const ACTIVATE_DISTANCE_THRESHOLD = 0.4

const handleActivate = async (
  kgraphRef: ActorRef<KgraphMsg>,
  userId: string,
  args: Record<string, unknown>,
  queue: IndexQueue,
  log: any,
): Promise<string> => {
  const text = args.text as string
  log.info('zettel-notes: semantic activate', { userId, text: text.slice(0, 50) + '...' })

  const reply = await ask<KgraphMsg, VectorSearchReply>(
    kgraphRef,
    (replyTo) => ({ type: 'vectorSearch', label: 'Note', text, topN: 5, userId, replyTo }),
  )

  const index = await queue.current(userId)

  if (reply.type === 'vectorSearchError') {
    log.warn('zettel-notes: vector search failed, falling back to recent notes', { userId, error: reply.error })
    // No embedding configured — return recent notes as fallback
    return JSON.stringify(
      index.notes.slice(-10).map(({ id, name, synopsis, tags }) => ({ id, name, synopsis, tags })),
    )
  }

  const results = reply.matches
    .filter(m => m.distance <= ACTIVATE_DISTANCE_THRESHOLD)
    .flatMap(m => {
      const noteIdMatch = m.description?.match(/^noteId:([a-f0-9-]{36})/)
      const noteId = noteIdMatch?.[1]
      const note = noteId
        ? index.notes.find(n => n.id === noteId)
        : index.notes.find(n => n.name === m.name)
      return note ? [{ id: note.id, name: note.name, synopsis: note.synopsis, tags: note.tags }] : []
    })

  log.debug('zettel-notes: activation results', { userId, count: results.length })
  return JSON.stringify(results)
}

// ─── Actor definition ───

export const createZettelNotesActor = (kgraphRef: ActorRef<KgraphMsg>): ActorDef<ZettelNoteMsg, ZettelState> => {
  const queue = makeIndexQueue()

  return {
  lifecycle: onLifecycle({
    start: (_state) => ({ state: { kgraphRef } }),
  }),

  handler: onMessage<ZettelNoteMsg, ZettelState>({
    invoke: (state, msg, ctx) => {
      if (!state) {
        msg.replyTo.send({ type: 'toolError', error: 'zettel-notes not ready' })
        return { state }
      }

      const { toolName, arguments: rawArgs, replyTo } = msg
      const userId = msg.userId ?? 'default'

      ctx.pipeToSelf(
        (async () => {
          const args = JSON.parse(rawArgs) as Record<string, unknown>
          const effectiveUserId = (args.userId as string | undefined) ?? userId
          switch (toolName) {
            case ZETTEL_CREATE_TOOL:   return handleCreate(state.kgraphRef, effectiveUserId, args, queue, ctx.log)
            case ZETTEL_UPDATE_TOOL:   return handleUpdate(state.kgraphRef, effectiveUserId, args, queue, ctx.log)
            case ZETTEL_READ_TOOL:     return handleRead(effectiveUserId, args, queue, ctx.log)
            case ZETTEL_LIST_TOOL:     return handleList(effectiveUserId, args, queue, ctx.log)
            case ZETTEL_SEARCH_TOOL:   return handleSearch(effectiveUserId, args, queue, ctx.log)
            case ZETTEL_ACTIVATE_TOOL: return handleActivate(state.kgraphRef, effectiveUserId, args, queue, ctx.log)
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
