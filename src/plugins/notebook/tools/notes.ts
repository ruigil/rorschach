import { mkdir, unlink } from 'node:fs/promises'
import { extname, basename } from 'node:path'
import type { ActorDef, ActorRef, SpanHandle } from '../../../system/types.ts'
import { onMessage } from '../../../system/match.ts'
import { defineTool } from '../../../system/tool-utils.ts'
import type { ToolInvokeMsg, ToolReply } from '../../../types/tools.ts'
import type { Attachment, NoteEntry } from '../types.ts'

// ─── Tool names & schemas ───

export const notesCreateTool = defineTool('notes_create', 'Create a new note with a title, markdown content, and optional tags. Wiki-style [[links]] to other notes are supported. IMPORTANT: Only use this tool when the user explicitly requests to create or manage a note. Do NOT use this tool to remember random facts or general user context; rely on the memory store instead.', {
  type: 'object',
  properties: {
    title:   { type: 'string', description: 'Note title.' },
    content: { type: 'string', description: 'Note body in markdown.' },
    tags:    { type: 'array', items: { type: 'string' }, description: 'Optional list of subject tags.' },
  },
  required: ['title', 'content'],
})

export const notesUpdateTool = defineTool('notes_update', 'Update an existing note by id. IMPORTANT: Only use this tool for explicit user notes. Do not use for general facts or memory context.', {
  type: 'object',
  properties: {
    id:      { type: 'string', description: 'Note id.' },
    content: { type: 'string', description: 'New markdown content (replaces existing).' },
    tags:    { type: 'array', items: { type: 'string' }, description: 'New tags (replaces existing).' },
  },
  required: ['id'],
})

export const notesReadTool = defineTool('notes_read', 'Read a note by id or title.', {
  type: 'object',
  properties: {
    id:    { type: 'string', description: 'Note id.' },
    title: { type: 'string', description: 'Note title (used if id is not provided).' },
  },
})

export const notesListTool = defineTool('notes_list', 'List notes, optionally filtered by tags.', {
  type: 'object',
  properties: {
    tags: { type: 'array', items: { type: 'string' }, description: 'Filter to notes that have ALL of these tags.' },
  },
})

export const notesSearchTool = defineTool('notes_search', 'Full-text search across all note content.', {
  type: 'object',
  properties: {
    query: { type: 'string', description: 'Text to search for (case-insensitive).' },
  },
  required: ['query'],
})

export const notesDeleteTool = defineTool('notes_delete', 'Permanently delete a note by id.', {
  type: 'object',
  properties: {
    id: { type: 'string', description: 'Note id.' },
  },
  required: ['id'],
})

export const notesAttachFileTool = defineTool('notes_attach_file', 'Attach a file (image, PDF, or other) to a note. The file must be in the inbound directory. A reference is added to the note body.', {
  type: 'object',
  properties: {
    id:       { type: 'string', description: 'Note id.' },
    filePath: { type: 'string', description: 'Absolute path to the file to attach.' },
    caption:  { type: 'string', description: 'Optional caption or label for the attachment.' },
  },
  required: ['id', 'filePath'],
})

// ─── Internal message type ───

type NotesMsg =
  | ToolInvokeMsg
  | { type: '_done';  replyTo: ActorRef<ToolReply>; toolName: string; result: string; span: SpanHandle | null }
  | { type: '_error'; replyTo: ActorRef<ToolReply>; toolName: string; error: string; span: SpanHandle | null }

// ─── Index helpers ───

type NotesIndex = { notes: NoteEntry[] }

const indexPath       = (notebookDir: string) => `${notebookDir}/notes/index.json`
const notePath        = (notebookDir: string, id: string) => `${notebookDir}/notes/${id}.md`
const notesDir        = (notebookDir: string) => `${notebookDir}/notes`
const attachmentUrl   = (id: string) => `/notebook/attachments/${encodeURIComponent(id)}`

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
  const attachments = (entry.attachments ?? [])
    .map(a => `- [${a.originalName}](${attachmentUrl(a.id)}) (${a.mimeType})`)
    .join('\n')
  return [
    `Tags: ${entry.tags.join(', ') || 'none'}`,
    `Created: ${new Date(entry.createdAt).toISOString()}`,
    attachments ? `Attachments:\n${attachments}` : '',
    content,
  ].filter(Boolean).join('\n\n')
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
  const attachUrl = attachmentUrl(attachId)
  const mdRef = IMAGE_EXTS.has(ext)
    ? `\n![${label}](${attachUrl})\n`
    : `\n[${label}](${attachUrl})\n`

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

export const Notes = (notebookDir: string): ActorDef<NotesMsg, null> => ({
  initialState: null,
  handler: onMessage<NotesMsg, null>({
    invoke: (state, msg, ctx) => {
      let promise: Promise<string>
      try {
        const args = JSON.parse(msg.arguments) as Record<string, unknown>

        if (msg.toolName === notesCreateTool.name) {
          const args = JSON.parse(msg.arguments) as { title: string; content: string; tags?: string[] }
          promise = createNote(notebookDir, args.title, args.content, args.tags ?? [])
        } else if (msg.toolName === notesUpdateTool.name) {
          const args = JSON.parse(msg.arguments) as { id: string; content?: string; tags?: string[] }
          promise = updateNote(notebookDir, args.id, args.content, args.tags)
        } else if (msg.toolName === notesReadTool.name) {
          const args = JSON.parse(msg.arguments) as { id?: string; title?: string }
          promise = readNote(notebookDir, args.id, args.title)
        } else if (msg.toolName === notesListTool.name) {
          const args = JSON.parse(msg.arguments) as { tags?: string[] }
          promise = listNotes(notebookDir, args.tags)
        } else if (msg.toolName === notesSearchTool.name) {
          const args = JSON.parse(msg.arguments) as { query: string }
          promise = searchNotes(notebookDir, args.query)
        } else if (msg.toolName === notesAttachFileTool.name) {
          const args = JSON.parse(msg.arguments) as { id: string; filePath: string }
          promise = attachFile(notebookDir, args.id, args.filePath)
        } else if (msg.toolName === notesDeleteTool.name) {
          const args = JSON.parse(msg.arguments) as { id: string }
          promise = deleteNote(notebookDir, args.id)
        } else {
          promise = Promise.reject(new Error(`Unknown tool: ${msg.toolName}`))
        }
      } catch (e) {
        promise = Promise.reject(e)
      }
      const parent = ctx.trace.fromHeaders()
      const span: SpanHandle | null = parent
        ? ctx.trace.child(parent.traceId, parent.spanId, msg.toolName, { toolName: msg.toolName })
        : null
      ctx.pipeToSelf(
        promise,
        (result) => ({ type: '_done'  as const, replyTo: msg.replyTo, toolName: msg.toolName, result, span }),
        (error)  => ({ type: '_error' as const, replyTo: msg.replyTo, toolName: msg.toolName, error: String(error), span }),
      )
      return { state }
    },

    _done: (state, msg) => {
      msg.span?.done()
      msg.replyTo.send({ type: 'toolResult', result: { text: msg.result } })
      return { state }
    },

    _error: (state, msg, ctx) => {
      ctx.log.error('notes error', { tool: msg.toolName, error: msg.error })
      msg.span?.error(msg.error)
      msg.replyTo.send({ type: 'toolError', error: msg.error })
      return { state }
    },
  }),

  supervision: { type: 'restart', maxRetries: 5, withinMs: 60_000 },
})
