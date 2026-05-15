import { resolve, sep } from 'node:path'
import type { ActorRef } from '../../system/types.ts'
import type { RouteRegistration } from '../../types/routes.ts'
import type { ConfigSchemaSection } from '../../types/config.ts'
import { resolveCookieIdentity } from '../../types/identity.ts'
import type { IdentityProviderMsg } from '../../types/identity.ts'
import type { NoteEntry } from './types.ts'

// ─── Config Schema Sections ──────────────────────────────────────────────────

export const notebookSchema: ConfigSchemaSection = {
  id: 'notebook.config',
  title: 'Notebook',
  subtitle: 'notebook · notes, journal, todos, and tracker',
  tab: 'notebook',
  configKey: '',
  routeId: 'config.notebook',
  schema: {
    type: 'object',
    properties: {
      notebookDir: { type: 'string', default: 'workspace/notebook', 'x-ui': { label: 'Notebook directory' } },
      agentModel: { type: 'string', 'x-ui': { widget: 'model-select', label: 'Agent model' } },
      maxToolLoops: { type: 'number', default: 10, minimum: 1, maximum: 50 },
    },
  },
}

export const notebookSchemas = [notebookSchema]

const ATTACHMENT_ROUTE_ID = 'notebook.attachments.api'
const ATTACHMENT_ROUTE_PREFIX = '/notebook/attachments/'
const MEDIA_DIR = resolve(import.meta.dir, '../../..', 'workspace/media')

export { ATTACHMENT_ROUTE_ID, ATTACHMENT_ROUTE_PREFIX }

const resolveUnder = (baseDir: string, relPath: string): string | null => {
  const base = resolve(baseDir)
  const filePath = resolve(base, relPath)
  return filePath === base || filePath.startsWith(base + sep) ? filePath : null
}

export const buildNotebookRoutes = (
  identityProviderRef: ActorRef<IdentityProviderMsg> | null,
  notebookDir: string,
): RouteRegistration[] => [
  {
    id: ATTACHMENT_ROUTE_ID,
    method: 'GET',
    path: ATTACHMENT_ROUTE_PREFIX,
    match: 'prefix',
    handler: async (req: Request, url: URL) => {
      const session = await resolveCookieIdentity(identityProviderRef, req)

      if (!session) return new Response('Unauthorized', { status: 401 })

      let attachmentId: string
      try {
        attachmentId = decodeURIComponent(url.pathname.slice(ATTACHMENT_ROUTE_PREFIX.length))
      } catch {
        return new Response('Bad request', { status: 400 })
      }

      if (!attachmentId || attachmentId.includes('/')) return new Response('Not Found', { status: 404 })

      const indexFile = Bun.file(`${notebookDir}/notes/index.json`)
      if (!await indexFile.exists()) return new Response('Not Found', { status: 404 })

      const index = JSON.parse(await indexFile.text()) as { notes: NoteEntry[] }
      const attachment = index.notes.flatMap(n => n.attachments ?? []).find(a => a.id === attachmentId)
      if (!attachment) return new Response('Not Found', { status: 404 })

      const filePath = resolveUnder(MEDIA_DIR, attachment.path)
      if (!filePath) return new Response('Not Found', { status: 404 })

      const file = Bun.file(filePath)
      if (!await file.exists()) return new Response('Not Found', { status: 404 })

      return new Response(file, {
        headers: {
          'Content-Type': attachment.mimeType,
          'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(attachment.originalName)}`,
        },
      })
    },
  },
]
