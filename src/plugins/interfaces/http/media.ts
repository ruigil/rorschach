import { resolve, sep } from 'node:path'

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

