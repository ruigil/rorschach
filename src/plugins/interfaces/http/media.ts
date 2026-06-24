import { join, resolve, sep } from 'node:path'
import { mkdir } from 'node:fs/promises'
import type { MessageAttachment } from '../../../types/events.ts'

const MEDIA_DIR = join(import.meta.dir, '../../../../', 'workspace/media')
const INBOUND_DIR = join(MEDIA_DIR, 'inbound')

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
}

export const mimeType = (path: string): string => {
  const ext = path.slice(path.lastIndexOf('.')).toLowerCase()
  return MIME_TYPES[ext] ?? 'application/octet-stream'
}

export const safeJoinUrlPath = (baseDir: string, pathname: string): string | null => {
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return null
  }

  const base = resolve(baseDir)
  const filePath = resolve(base, `.${decoded}`)
  return filePath === base || filePath.startsWith(base + sep) ? filePath : null
}

export const saveAttachmentsToTempFiles = (attachments: MessageAttachment[]): Promise<MessageAttachment[]> =>
  Promise.all(attachments.map(async (att) => {
    if (!att.data) return att

    const match = att.data.match(/^data:[^;]+;base64,(.+)$/)
    const b64 = match?.[1] ?? att.data
    const ext = att.mimeType?.split('/')[1] || att.name?.split('.').pop() || (att.kind === 'image' ? 'jpeg' : att.kind === 'audio' ? 'wav' : 'bin')
    const fileName = att.name ? `${att.name}-${crypto.randomUUID()}` : `rorschach-${crypto.randomUUID()}.${ext}`
    const filePath = join(INBOUND_DIR, fileName)

    await mkdir(INBOUND_DIR, { recursive: true })
    await Bun.write(filePath, Buffer.from(b64, 'base64'))

    return { ...att, url: filePath, data: undefined }
  }))
