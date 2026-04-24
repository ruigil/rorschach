import { mkdir, unlink } from 'node:fs/promises'
import { extname, basename } from 'node:path'
import type { ActorDef, ActorRef } from '../../../system/types.ts'
import { onMessage } from '../../../system/match.ts'
import type { ToolInvokeMsg, ToolReply, ToolSchema } from '../../../types/tools.ts'
import type { Attachment, NoteEntry } from '../types.ts'

// ─── Tool names & schemas ───

export const NOTES_CREATE_TOOL_NAME       = 'notes_create'
export const NOTES_UPDATE_TOOL_NAME       = 'notes_update'
export const NOTES_READ_TOOL_NAME         = 'notes_read'
export const NOTES_LIST_TOOL_NAME         = 'notes_list'
export const NOTES_SEARCH_TOOL_NAME       = 'notes_search'
export const NOTES_ATTACH_FILE_TOOL_NAME = 'notes_attach_file'
export const NOTES_DELETE_TOOL_NAME      = 'notes_delete'

export const NOTES_CREATE_SCHEMA: ToolSchema = {
  type: 'function',
  function: {
    name: NOTES_CREATE_TOOL_NAME,
    description: 'Create a new note with a title, markdown content, and optional tags. Wiki-style [[links]] to other notes are supported. IMPORTANT: Only use this tool when the user explicitly requests to create or manage a note. Do NOT use this tool to remember random facts or general user context; rely on the memory store instead.',
    parameters: {
      type: 'object',
      properties: {
        title:   { type: 'string', description: 'Note title.' },
        content: { type: 'string', description: 'Note body in markdown.' },
        tags:    { type: 'array', items: { type: 'string' }, description: 'Optional list of subject tags.' },
      },
      required: ['title', 'content'],
    },
  },
}

export const NOTES_UPDATE_SCHEMA: ToolSchema = {
  type: 'function',
  function: {
    name: NOTES_UPDATE_TOOL_NAME,
    description: 'Update an existing note by id. IMPORTANT: Only use this tool for explicit user notes. Do not use for general facts or memory context.',
    parameters: {
      type: 'object',
      properties: {
        id:      { type: 'string', description: 'Note id.' },
        content: { type: 'string', description: 'New markdown content (replaces existing).' },
        tags:    { type: 'array', items: { type: 'string' }, description: 'New tags (replaces existing).' },
      },
      required: ['id'],
    },
  },
}

export const NOTES_READ_SCHEMA: ToolSchema = {
  type: 'function',
  function: {
    name: NOTES_READ_TOOL_NAME,
    description: 'Read a note by id or title.',
    parameters: {
      type: 'object',
      properties: {
        id:    { type: 'string', description: 'Note id.' },
        title: { type: 'string', description: 'Note title (used if id is not provided).' },
      },
    },
  },
}

export const NOTES_LIST_SCHEMA: ToolSchema = {
  type: 'function',
  function: {
    name: NOTES_LIST_TOOL_NAME,
    description: 'List notes, optionally filtered by tags.',
    parameters: {
      type: 'object',
      properties: {
        tags: { type: 'array', items: { type: 'string' }, description: 'Filter to notes that have ALL of these tags.' },
      },
    },
  },
}

export const NOTES_SEARCH_SCHEMA: ToolSchema = {
  type: 'function',
  function: {
    name: NOTES_SEARCH_TOOL_NAME,
    description: 'Full-text search across all note content.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Text to search for (case-insensitive).' },
      },
      required: ['query'],
    },
  },
}

export const NOTES_DELETE_SCHEMA: ToolSchema = {
  type: 'function',
  function: {
    name: NOTES_DELETE_TOOL_NAME,
    description: 'Permanently delete a note by id.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Note id.' },
      },
      required: ['id'],
    },
  },
}

export const NOTES_ATTACH_FILE_SCHEMA: ToolSchema = {
  type: 'function',
  function: {
    name: NOTES_ATTACH_FILE_TOOL_NAME,
    description: 'Attach a file (image, PDF, or other) to a note. The file must be in the inbound directory. A reference is added to the note body.',
    parameters: {
      type: 'object',
      properties: {
        id:       { type: 'string', description: 'Note id.' },
        filePath: { type: 'string', description: 'Absolute path to the file to attach.' },
        caption:  { type: 'string', description: 'Optional caption or label for the attachment.' },
      },
      required: ['id', 'filePath'],
    },
  },
}

// ─── Internal message type ───

type NotesMsg =
  | ToolInvokeMsg
  | { type: '_done';  replyTo: ActorRef<ToolReply>; toolName: string; result: string }
  | { type: '_error'; replyTo: ActorRef<ToolReply>; toolName: string; error: string }

// ─── Index helpers ───

type NotesIndex = { notes: NoteEntry[] }

const indexPath       = (notebookDir: string) => `${notebookDir}/notes/index.json`
const notePath        = (notebookDir: string, id: string) => `${notebookDir}/notes/${id}.md`
const notesDir        = (notebookDir: string) => `${notebookDir}/notes`

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.avif'])

const mimeForExt = (ext: string): string => {
  const map: Record<string, string> = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
    '.avif': 'image/avif', '.pdf': 'application/pdf',
  }
  return map[ext] ?? 'application/octet-stream'
}

const readIndex = async (notebookDir: string): Promise<NotesIndex> => {
  const file = Bun.file(indexPath(notebookDir))
  if (!(await file.exists())) return { notes: [] }
  return JSON.parse(await file.text()) as NotesIndex
}

const writeIndex = async (notebookDir: string, index: NotesIndex): Promise<void> => {
  await mkdir(notesDir(notebookDir), { recursive: true })
  await Bun.write(indexPath(notebookDir), JSON.stringify(index, null, 2))
}

const extractLinks = (content: string): string[] => {
  const matches = content.matchAll(/\[\[([^\]]+)\]\]/g)
  return [...new Set([...matches].map(m => m[1]!))]
}

// ─── Operations ───

const createNote = async (
  notebookDir: string,
  title: string,
  content: string,
  tags: string[],
): Promise<string> => {
  const id    = crypto.randomUUID()
  const now   = Date.now()
  const links = extractLinks(content)
  const entry: NoteEntry = { id, title, tags, createdAt: now, updatedAt: now, path: `notes/${id}.md`, links, attachments: [] }

  await mkdir(notesDir(notebookDir), { recursive: true })
  await Bun.write(notePath(notebookDir, id), `# ${title}\n\n${content}`)

  const index = await readIndex(notebookDir)
  index.notes.push(entry)
  await writeIndex(notebookDir, index)

  return `Note created: id=${id}, title="${title}"`
}

const updateNote = async (
  notebookDir: string,
  id: string,
  content?: string,
  tags?: string[],
): Promise<string> => {
  const index = await readIndex(notebookDir)
  const entryIdx = index.notes.findIndex(n => n.id === id)
  if (entryIdx === -1) return `Note not found: ${id}`

  const entry = index.notes[entryIdx]!
  const now = Date.now()

  if (content !== undefined) {
    const links = extractLinks(content)
    const path  = notePath(notebookDir, id)
    const title = entry.title
    await Bun.write(path, `# ${title}\n\n${content}`)
    index.notes[entryIdx] = { ...entry, links, updatedAt: now }
  }
  if (tags !== undefined) {
    index.notes[entryIdx] = { ...index.notes[entryIdx]!, tags, updatedAt: now }
  }

  await writeIndex(notebookDir, index)
  return `Note updated: ${id}`
}

const readNote = async (notebookDir: string, id?: string, title?: string): Promise<string> => {
  const index = await readIndex(notebookDir)
  let entry: NoteEntry | undefined

  if (id) {
    entry = index.notes.find(n => n.id === id)
  } else if (title) {
    entry = index.notes.find(n => n.title.toLowerCase() === title.toLowerCase())
  }

  if (!entry) return `Note not found.`
  const content = await Bun.file(notePath(notebookDir, entry.id)).text().catch(() => '(content missing)')
  return `Tags: ${entry.tags.join(', ') || 'none'}\nCreated: ${new Date(entry.createdAt).toISOString()}\n\n${content}`
}

const listNotes = async (notebookDir: string, tags?: string[]): Promise<string> => {
  const index = await readIndex(notebookDir)
  let notes = index.notes
  if (tags && tags.length > 0) {
    notes = notes.filter(n => tags.every(t => n.tags.includes(t)))
  }
  if (notes.length === 0) return 'No notes found.'
  return notes.map(n => `[${n.id}] ${n.title} (tags: ${n.tags.join(', ') || 'none'})`).join('\n')
}

const searchNotes = async (notebookDir: string, query: string): Promise<string> => {
  const dir   = notesDir(notebookDir)
  const glob  = new Bun.Glob('*.md')
  const lower = query.toLowerCase()
  const results: string[] = []

  for await (const file of glob.scan({ cwd: dir })) {
    const content = await Bun.file(`${dir}/${file}`).text().catch(() => '')
    const lines   = content.split('\n')
    for (let i = 0; i < lines.length; i++) {
      if (lines[i]!.toLowerCase().includes(lower)) {
        results.push(`${file}:${i + 1}: ${lines[i]}`)
      }
    }
  }

  return results.length > 0 ? results.join('\n') : `No results for "${query}".`
}

const deleteNote = async (notebookDir: string, id: string): Promise<string> => {
  const index    = await readIndex(notebookDir)
  const entryIdx = index.notes.findIndex(n => n.id === id)
  if (entryIdx === -1) return `Note not found: ${id}`

  index.notes.splice(entryIdx, 1)
  await writeIndex(notebookDir, index)
  await unlink(notePath(notebookDir, id)).catch(() => {/* already gone */})

  return `Note deleted: ${id}`
}

const attachFile = async (
  notebookDir: string,
  id: string,
  filePath: string,
  caption?: string,
): Promise<string> => {
  const index    = await readIndex(notebookDir)
  const entryIdx = index.notes.findIndex(n => n.id === id)
  if (entryIdx === -1) return `Note not found: ${id}`

  const src      = Bun.file(filePath)
  if (!(await src.exists())) return `File not found: ${filePath}`

  const ext      = extname(filePath).toLowerCase()
  const origName = basename(filePath)
  const attachId = crypto.randomUUID()
  const label: string = caption ?? origName
  const attachPath = `inbound/${origName}`
  const mdRef = IMAGE_EXTS.has(ext)
    ? `\n![${label}](/inbound/${origName})\n`
    : `\n[${label}](/inbound/${origName})\n`

  const noteMd = notePath(notebookDir, id)
  const existing = await Bun.file(noteMd).text()
  await Bun.write(noteMd, existing + mdRef)

  const attachment: Attachment = {
    id:           attachId,
    originalName: origName,
    path:         attachPath,
    mimeType:     mimeForExt(ext),
    addedAt:      Date.now(),
  }
  const entry = index.notes[entryIdx]!
  index.notes[entryIdx] = {
    ...entry,
    attachments: [...(entry.attachments ?? []), attachment],
    updatedAt:   Date.now(),
  }
  await writeIndex(notebookDir, index)

  return `File attached to note ${id}: ${attachPath}`
}

// ─── Actor ───

export const createNotesActor = (notebookDir: string): ActorDef<NotesMsg, null> => ({
  handler: onMessage<NotesMsg, null>({
    invoke: (state, msg, ctx) => {
      let promise: Promise<string>
      try {
        const args = JSON.parse(msg.arguments) as Record<string, unknown>

        if (msg.toolName === NOTES_CREATE_TOOL_NAME) {
          ctx.log.info('notes: create', { title: args.title })
          promise = createNote(notebookDir, args.title as string, args.content as string, (args.tags as string[] | undefined) ?? [])
        } else if (msg.toolName === NOTES_UPDATE_TOOL_NAME) {
          ctx.log.info('notes: update', { id: args.id })
          promise = updateNote(notebookDir, args.id as string, args.content as string | undefined, args.tags as string[] | undefined)
        } else if (msg.toolName === NOTES_READ_TOOL_NAME) {
          ctx.log.info('notes: read', { id: args.id, title: args.title })
          promise = readNote(notebookDir, args.id as string | undefined, args.title as string | undefined)
        } else if (msg.toolName === NOTES_LIST_TOOL_NAME) {
          ctx.log.info('notes: list', { tags: args.tags })
          promise = listNotes(notebookDir, args.tags as string[] | undefined)
        } else if (msg.toolName === NOTES_SEARCH_TOOL_NAME) {
          ctx.log.info('notes: search', { query: args.query })
          promise = searchNotes(notebookDir, args.query as string)
        } else if (msg.toolName === NOTES_ATTACH_FILE_TOOL_NAME) {
          ctx.log.info('notes: attach file', { id: args.id, filePath: args.filePath })
          promise = attachFile(notebookDir, args.id as string, args.filePath as string, args.caption as string | undefined)
        } else if (msg.toolName === NOTES_DELETE_TOOL_NAME) {
          ctx.log.info('notes: delete', { id: args.id })
          promise = deleteNote(notebookDir, args.id as string)
        } else {
          promise = Promise.reject(new Error(`Unknown tool: ${msg.toolName}`))
        }
      } catch (e) {
        promise = Promise.reject(e)
      }
      ctx.pipeToSelf(
        promise,
        (result) => ({ type: '_done'  as const, replyTo: msg.replyTo, toolName: msg.toolName, result }),
        (error)  => ({ type: '_error' as const, replyTo: msg.replyTo, toolName: msg.toolName, error: String(error) }),
      )
      return { state }
    },

    _done: (state, msg) => {
      msg.replyTo.send({ type: 'toolResult', result: msg.result })
      return { state }
    },

    _error: (state, msg, ctx) => {
      ctx.log.error('notes error', { tool: msg.toolName, error: msg.error })
      msg.replyTo.send({ type: 'toolError', error: msg.error })
      return { state }
    },
  }),

  supervision: { type: 'restart', maxRetries: 5, withinMs: 60_000 },
})
