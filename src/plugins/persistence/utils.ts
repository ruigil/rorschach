import { join, resolve, dirname } from 'node:path'
import { mkdir } from 'node:fs/promises'

/**
 * Resolves a path relative to baseDir, preventing directory traversal.
 */
export function resolveSafePath(baseDir: string, relativePath: string): string {
  const absoluteBase = resolve(baseDir)
  const absoluteTarget = resolve(join(absoluteBase, relativePath))

  if (!absoluteTarget.startsWith(absoluteBase)) {
    throw new Error(`Directory traversal detected: ${relativePath}`)
  }
  return absoluteTarget
}

/**
 * Ensures the parent directory of filePath exists.
 */
export async function ensureParentDir(filePath: string): Promise<void> {
  const parent = dirname(filePath)
  await mkdir(parent, { recursive: true })
}
