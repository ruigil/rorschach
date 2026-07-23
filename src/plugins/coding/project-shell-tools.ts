import type { IFileSystem } from 'just-bash'
import { defineTool } from '../../system/index.ts'
import { truncateForAgent, WORKSPACE_MOUNT } from './project-shell-path.ts'

export { WORKSPACE_MOUNT }

/** Soft caps and walk limits for search/discovery tools. */
export const DEFAULT_GREP_MAX_MATCHES = 50
export const MAX_GREP_MAX_MATCHES = 200
export const DEFAULT_GLOB_MAX_RESULTS = 200
export const MAX_GLOB_MAX_RESULTS = 1_000
export const MAX_WALK_FILES = 5_000
export const MAX_GREP_FILE_BYTES = 512 * 1024
export const MAX_WRITE_CHARS = 1_000_000
export const MAX_GREP_PATTERN_CHARS = 500
export const MAX_GREP_CONTEXT = 5

export const SKIP_DIR_NAMES = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.cache',
  'coverage',
])

export const codingGrepTool = defineTool(
  'grep',
  'Search file contents under /rorschach or /workspace with a JS regex. Prefer over bash rg/grep. Supports path, glob filter, and maxMatches.',
  {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'JavaScript regular expression source to search for.' },
      path: {
        type: 'string',
        description: 'Absolute search root under /rorschach or /workspace (default: project mount).',
      },
      glob: {
        type: 'string',
        description: 'Optional glob filter on paths relative to the search root (e.g. "*.ts", "**/*.md").',
      },
      caseInsensitive: {
        type: 'boolean',
        description: 'Case-insensitive match (default false).',
      },
      maxMatches: {
        type: 'number',
        description: `Max matches to return (default ${DEFAULT_GREP_MAX_MATCHES}, max ${MAX_GREP_MAX_MATCHES}).`,
      },
      context: {
        type: 'number',
        description: `Lines of context before/after each match (default 0, max ${MAX_GREP_CONTEXT}).`,
      },
    },
    required: ['pattern'],
  },
)

export const codingGlobTool = defineTool(
  'glob',
  'Find file paths under /rorschach or /workspace matching a glob pattern (* ? **). Prefer over bash find/ls for discovery.',
  {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: 'Glob pattern, e.g. "**/*.ts", "plugins/*/types.ts".',
      },
      path: {
        type: 'string',
        description: 'Absolute root under /rorschach or /workspace (default: project mount).',
      },
      maxResults: {
        type: 'number',
        description: `Max paths to return (default ${DEFAULT_GLOB_MAX_RESULTS}, max ${MAX_GLOB_MAX_RESULTS}).`,
      },
    },
    required: ['pattern'],
  },
)

export const codingWriteTool = defineTool(
  'write',
  'Write a UTF-8 file under /workspace only (project mount is read-only). Overwrites existing files. Creates parent directories by default.',
  {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Absolute path under /workspace.',
      },
      content: {
        type: 'string',
        description: 'Full file contents to write (overwrite).',
      },
      createDirs: {
        type: 'boolean',
        description: 'Create parent directories if missing (default true).',
      },
    },
    required: ['path', 'content'],
  },
)

export const codingStrReplaceTool = defineTool(
  'str_replace',
  'Replace an exact UTF-8 substring in an existing file under /workspace only. Prefer over write for small edits. Fails if old_string is missing or not unique (unless replace_all). Never include read-tool line-number prefixes (N|) in old_string/new_string.',
  {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Absolute path under /workspace.',
      },
      old_string: {
        type: 'string',
        description: 'Exact text to find (include enough surrounding context to be unique).',
      },
      new_string: {
        type: 'string',
        description: 'Replacement text (may be empty to delete the matched text).',
      },
      replace_all: {
        type: 'boolean',
        description: 'Replace every non-overlapping occurrence (default false; requires a unique match when false).',
      },
    },
    required: ['path', 'old_string', 'new_string'],
  },
)

export type GrepToolArgs = {
  pattern: string
  path?: string
  glob?: string
  caseInsensitive?: boolean
  maxMatches?: number
  context?: number
}

export type GlobToolArgs = {
  pattern: string
  path?: string
  maxResults?: number
}

export type WriteToolArgs = {
  path: string
  content: string
  createDirs?: boolean
}

export type StrReplaceToolArgs = {
  path: string
  old_string: string
  new_string: string
  replace_all?: boolean
}

export type PathResolveResult = { ok: true; path: string } | { ok: false; error: string }

/** Count non-overlapping occurrences of needle in haystack (left-to-right). */
export const countOccurrences = (haystack: string, needle: string): number => {
  if (!needle) return 0
  let count = 0
  let from = 0
  while (from <= haystack.length) {
    const idx = haystack.indexOf(needle, from)
    if (idx === -1) break
    count += 1
    from = idx + needle.length
  }
  return count
}

/** 1-based line number of the first character index in content (1 if empty). */
export const lineNumberAtIndex = (content: string, index: number): number => {
  if (index <= 0) return 1
  let line = 1
  const end = Math.min(index, content.length)
  for (let i = 0; i < end; i++) {
    if (content[i] === '\n') line += 1
  }
  return line
}

/**
 * Convert a glob pattern to a RegExp that matches full relative paths.
 * Supports `*`, `?`, and `**` (across path segments).
 */
export const compileGlob = (pattern: string): RegExp => {
  const trimmed = pattern.trim()
  if (!trimmed) return /^$/

  let source = ''
  let i = 0
  while (i < trimmed.length) {
    const ch = trimmed[i]!
    if (ch === '*' && trimmed[i + 1] === '*') {
      // ** or **/
      if (trimmed[i + 2] === '/') {
        source += '(?:.*/)?'
        i += 3
      } else {
        source += '.*'
        i += 2
      }
      continue
    }
    if (ch === '*') {
      source += '[^/]*'
      i += 1
      continue
    }
    if (ch === '?') {
      source += '[^/]'
      i += 1
      continue
    }
    if ('\\.[]{}()+-^$|'.includes(ch)) {
      source += `\\${ch}`
      i += 1
      continue
    }
    source += ch
    i += 1
  }

  return new RegExp(`^${source}$`)
}

/** Test whether a relative path matches a glob pattern. */
export const matchGlob = (pattern: string, relPath: string): boolean => {
  const normalized = relPath.replace(/^\/+/, '').replace(/\/+$/, '')
  return compileGlob(pattern).test(normalized)
}

export const compileSearchRegex = (
  pattern: string,
  caseInsensitive = false,
): { ok: true; regex: RegExp } | { ok: false; error: string } => {
  if (!pattern) return { ok: false, error: 'Missing required argument: pattern' }
  if (pattern.length > MAX_GREP_PATTERN_CHARS) {
    return {
      ok: false,
      error: `pattern too long (max ${MAX_GREP_PATTERN_CHARS} chars)`,
    }
  }
  try {
    return {
      ok: true,
      regex: new RegExp(pattern, caseInsensitive ? 'i' : undefined),
    }
  } catch (err) {
    return { ok: false, error: `Invalid regex pattern: ${String(err)}` }
  }
}

const clampInt = (value: number | undefined, fallback: number, min: number, max: number): number => {
  if (value === undefined || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.floor(value)))
}

const joinVirtual = (root: string, name: string): string => {
  if (root === '/') return `/${name}`
  return `${root.replace(/\/+$/, '')}/${name}`
}

const relFromRoot = (root: string, absPath: string): string => {
  if (absPath === root) return ''
  const prefix = root === '/' ? '/' : `${root.replace(/\/+$/, '')}/`
  if (absPath.startsWith(prefix)) return absPath.slice(prefix.length)
  return absPath.replace(/^\/+/, '')
}

export type WalkFile = {
  absPath: string
  relPath: string
  size: number
}

/**
 * Depth-first walk of files under root. Skips heavy directories and caps file count.
 */
export async function* walkFiles(
  fs: IFileSystem,
  root: string,
  options?: {
    skipDirNames?: Set<string>
    maxFiles?: number
    fileFilter?: (absPath: string, relPath: string) => boolean
  },
): AsyncGenerator<WalkFile> {
  const skipDirNames = options?.skipDirNames ?? SKIP_DIR_NAMES
  const maxFiles = options?.maxFiles ?? MAX_WALK_FILES
  const fileFilter = options?.fileFilter

  const stack: string[] = [root]
  let yielded = 0

  while (stack.length > 0 && yielded < maxFiles) {
    const dir = stack.pop()!
    let names: string[]
    try {
      names = await fs.readdir(dir)
    } catch {
      continue
    }

    // Stable order for deterministic results.
    names = [...names].sort()

    for (const name of names) {
      if (yielded >= maxFiles) break
      const absPath = joinVirtual(dir, name)
      let st: { isDirectory: boolean; isFile: boolean; size: number }
      try {
        st = await fs.stat(absPath)
      } catch {
        continue
      }

      if (st.isDirectory) {
        if (skipDirNames.has(name)) continue
        stack.push(absPath)
        continue
      }

      if (!st.isFile) continue

      const relPath = relFromRoot(root, absPath)
      if (fileFilter && !fileFilter(absPath, relPath)) continue

      yielded += 1
      yield { absPath, relPath, size: st.size ?? 0 }
    }
  }
}

export type GrepMatch = {
  path: string
  line: number
  text: string
  before: string[]
  after: string[]
}

export const formatGrepResult = (matches: GrepMatch[], truncated: boolean): string => {
  if (matches.length === 0) {
    return truncateForAgent('// matches: 0\n(no matches)')
  }

  const lines: string[] = []
  for (const m of matches) {
    for (const b of m.before) {
      lines.push(`${m.path}-${b}`)
    }
    lines.push(`${m.path}:${m.line}:${m.text}`)
    for (const a of m.after) {
      lines.push(`${m.path}+${a}`)
    }
  }
  lines.push(`// matches: ${matches.length}`)
  if (truncated) {
    lines.push('// … truncated at maxMatches; narrow path/glob/pattern')
  }
  return truncateForAgent(lines.join('\n'))
}

const collectMatchesFromContent = (
  absPath: string,
  content: string,
  regex: RegExp,
  maxMatches: number,
  context: number,
  matches: GrepMatch[],
): boolean => {
  if (content.includes('\0')) return false
  if (content.length > MAX_GREP_FILE_BYTES) return false

  const lines = content.split('\n')
  for (let i = 0; i < lines.length; i++) {
    if (matches.length >= maxMatches) return true
    const lineText = lines[i]!
    regex.lastIndex = 0
    if (!regex.test(lineText)) continue

    const before: string[] = []
    const after: string[] = []
    if (context > 0) {
      for (let b = Math.max(0, i - context); b < i; b++) {
        before.push(`${b + 1}:${lines[b]}`)
      }
      for (let a = i + 1; a <= Math.min(lines.length - 1, i + context); a++) {
        after.push(`${a + 1}:${lines[a]}`)
      }
    }

    matches.push({
      path: absPath,
      line: i + 1,
      text: lineText,
      before,
      after,
    })
  }
  return matches.length >= maxMatches
}

export const runGrep = async (
  fs: IFileSystem,
  root: string,
  args: {
    pattern: string
    caseInsensitive?: boolean
    glob?: string
    maxMatches?: number
    context?: number
  },
): Promise<{ ok: true; text: string } | { ok: false; error: string }> => {
  const compiled = compileSearchRegex(args.pattern, args.caseInsensitive === true)
  if (!compiled.ok) return compiled

  const maxMatches = clampInt(args.maxMatches, DEFAULT_GREP_MAX_MATCHES, 1, MAX_GREP_MAX_MATCHES)
  const context = clampInt(args.context, 0, 0, MAX_GREP_CONTEXT)
  const globPat = typeof args.glob === 'string' && args.glob.trim() ? args.glob.trim() : undefined

  const matches: GrepMatch[] = []
  let truncated = false

  const filter = globPat
    ? (_abs: string, rel: string) => {
        if (matchGlob(globPat, rel)) return true
        // Also allow basename-only patterns like "*.ts" against nested files.
        const base = rel.includes('/') ? rel.slice(rel.lastIndexOf('/') + 1) : rel
        return matchGlob(globPat, base)
      }
    : undefined

  let rootStat: { isFile: boolean; isDirectory: boolean; size: number }
  try {
    rootStat = await fs.stat(root)
  } catch (err) {
    return { ok: false, error: String(err) }
  }

  const searchOne = async (file: WalkFile): Promise<boolean> => {
    if (file.size > MAX_GREP_FILE_BYTES) return false
    let content: string
    try {
      content = await fs.readFile(file.absPath)
    } catch {
      return false
    }
    return collectMatchesFromContent(file.absPath, content, compiled.regex, maxMatches, context, matches)
  }

  if (rootStat.isFile) {
    const file: WalkFile = {
      absPath: root,
      relPath: root.split('/').pop() || root,
      size: rootStat.size ?? 0,
    }
    if (!filter || filter(file.absPath, file.relPath)) {
      truncated = await searchOne(file)
    }
  } else if (rootStat.isDirectory) {
    for await (const file of walkFiles(fs, root, { fileFilter: filter })) {
      const hitCap = await searchOne(file)
      if (hitCap) {
        truncated = true
        break
      }
    }
  } else {
    return { ok: false, error: `Not a file or directory: ${root}` }
  }

  return { ok: true, text: formatGrepResult(matches, truncated) }
}

export const formatGlobResult = (paths: string[], truncated: boolean): string => {
  if (paths.length === 0) {
    return truncateForAgent('// results: 0\n(no matches)')
  }
  let text = paths.join('\n')
  text += `\n// results: ${paths.length}`
  if (truncated) {
    text += '\n// … truncated at maxResults; narrow pattern/path'
  }
  return truncateForAgent(text)
}

export const runGlob = async (
  fs: IFileSystem,
  root: string,
  args: { pattern: string; maxResults?: number },
): Promise<{ ok: true; text: string } | { ok: false; error: string }> => {
  const pattern = args.pattern.trim()
  if (!pattern) return { ok: false, error: 'Missing required argument: pattern' }

  const maxResults = clampInt(args.maxResults, DEFAULT_GLOB_MAX_RESULTS, 1, MAX_GLOB_MAX_RESULTS)
  const results: string[] = []
  let truncated = false

  let rootStat: { isFile: boolean; isDirectory: boolean }
  try {
    rootStat = await fs.stat(root)
  } catch (err) {
    return { ok: false, error: String(err) }
  }

  if (rootStat.isFile) {
    const rel = root.split('/').pop() || root
    if (matchGlob(pattern, rel) || matchGlob(pattern, relFromRoot(root, root))) {
      results.push(root)
    }
    return { ok: true, text: formatGlobResult(results, false) }
  }

  if (!rootStat.isDirectory) {
    return { ok: false, error: `Not a file or directory: ${root}` }
  }

  for await (const file of walkFiles(fs, root)) {
    if (results.length >= maxResults) {
      truncated = true
      break
    }
    if (matchGlob(pattern, file.relPath)) {
      results.push(file.absPath)
    }
  }

  results.sort()
  return { ok: true, text: formatGlobResult(results, truncated) }
}

export const assertWorkspaceWritePath = (normalized: string): PathResolveResult => {
  if (normalized === WORKSPACE_MOUNT || normalized.startsWith(`${WORKSPACE_MOUNT}/`)) {
    if (normalized === WORKSPACE_MOUNT) {
      return { ok: false, error: 'path must be a file under /workspace, not the mount root' }
    }
    return { ok: true, path: normalized }
  }
  return {
    ok: false,
    error:
      'Refusing write: project is read-only; use /workspace or write_html_page for docs.',
  }
}

export const runWrite = async (
  fs: IFileSystem,
  path: string,
  args: { content: string; createDirs?: boolean },
): Promise<{ ok: true; text: string } | { ok: false; error: string }> => {
  if (typeof args.content !== 'string') {
    return { ok: false, error: 'Missing required argument: content' }
  }
  if (args.content.length > MAX_WRITE_CHARS) {
    return {
      ok: false,
      error: `content too large (max ${MAX_WRITE_CHARS} chars, got ${args.content.length})`,
    }
  }

  const createDirs = args.createDirs !== false
  let existed = false
  try {
    existed = await fs.exists(path)
  } catch {
    existed = false
  }

  if (createDirs) {
    const parent = path.replace(/\/[^/]+$/, '')
    if (parent && parent !== path && parent.startsWith(WORKSPACE_MOUNT)) {
      try {
        await fs.mkdir(parent, { recursive: true })
      } catch (err) {
        // Parent may already exist; only fail if write fails later.
        const msg = String(err)
        if (!/exist|EEXIST/i.test(msg)) {
          // Try write anyway if mkdir failed for other reasons on existing trees.
        }
      }
    }
  }

  try {
    await fs.writeFile(path, args.content)
  } catch (err) {
    return { ok: false, error: String(err) }
  }

  const action = existed ? 'Overwrote' : 'Wrote'
  return {
    ok: true,
    text: `${action} ${args.content.length} chars to ${path}`,
  }
}

export const runStrReplace = async (
  fs: IFileSystem,
  path: string,
  args: { old_string: string; new_string: string; replace_all?: boolean },
): Promise<{ ok: true; text: string } | { ok: false; error: string }> => {
  if (typeof args.old_string !== 'string' || args.old_string.length === 0) {
    return { ok: false, error: 'old_string must be a non-empty string' }
  }
  if (typeof args.new_string !== 'string') {
    return { ok: false, error: 'Missing required argument: new_string' }
  }
  if (args.old_string === args.new_string) {
    return { ok: false, error: 'old_string and new_string are identical; no change to apply' }
  }

  let content: string
  try {
    const exists = await fs.exists(path)
    if (!exists) {
      return { ok: false, error: `File not found: ${path}` }
    }
    content = await fs.readFile(path)
  } catch (err) {
    return { ok: false, error: String(err) }
  }

  if (content.includes('\0')) {
    return { ok: false, error: `Refusing to edit binary file: ${path}` }
  }
  if (content.length > MAX_WRITE_CHARS) {
    return {
      ok: false,
      error: `file too large to edit (max ${MAX_WRITE_CHARS} chars, got ${content.length})`,
    }
  }

  const replaceAll = args.replace_all === true
  const matches = countOccurrences(content, args.old_string)

  if (matches === 0) {
    const preview =
      args.old_string.length > 80 ? `${args.old_string.slice(0, 80)}…` : args.old_string
    return {
      ok: false,
      error: `old_string not found in ${path}: ${JSON.stringify(preview)}`,
    }
  }

  if (!replaceAll && matches > 1) {
    return {
      ok: false,
      error:
        `old_string matched ${matches} times in ${path}; provide more context for a unique match, or set replace_all: true`,
    }
  }

  const firstIdx = content.indexOf(args.old_string)
  const firstLine = lineNumberAtIndex(content, firstIdx)

  const next = replaceAll
    ? content.split(args.old_string).join(args.new_string)
    : content.slice(0, firstIdx) + args.new_string + content.slice(firstIdx + args.old_string.length)

  if (next.length > MAX_WRITE_CHARS) {
    return {
      ok: false,
      error: `result too large (max ${MAX_WRITE_CHARS} chars, got ${next.length})`,
    }
  }

  try {
    await fs.writeFile(path, next)
  } catch (err) {
    return { ok: false, error: String(err) }
  }

  const n = replaceAll ? matches : 1
  return {
    ok: true,
    text:
      `Replaced ${n} occurrence${n === 1 ? '' : 's'} in ${path}` +
      ` (first at line ${firstLine}; was ${content.length} chars, now ${next.length} chars)`,
  }
}
