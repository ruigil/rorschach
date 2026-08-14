import type { ToolSchema, ToolFilter } from '../../types/tools.ts'

// ─── Schema (what the LLM sees) ───

export const defineTool = (
  name: string,
  description: string,
  parameters: object,
): { name: string; schema: ToolSchema } => ({
  name,
  schema: {
    type: 'function',
    function: { name, description, parameters },
  },
})

// ─── Tool filtering and parsing ───

type ToolParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string }

export const parseToolArgs = <T>(
  rawArgs: unknown,
  extract: (parsed: Record<string, unknown>) => T | null,
  missingMsg = 'Missing required arguments',
): ToolParseResult<T> => {
  let parsed: unknown = rawArgs
  if (typeof rawArgs === 'string') {
    try {
      parsed = JSON.parse(rawArgs)
    } catch {
      return { ok: false, error: 'Invalid arguments: expected JSON object' }
    }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: 'Invalid arguments: expected JSON object' }
  }
  const value = extract(parsed as Record<string, unknown>)
  if (value === null) return { ok: false, error: missingMsg }
  return { ok: true, value }
}

export const applyToolFilter = (name: string, filter?: ToolFilter): boolean => {
  if (!filter) return true
  if ('allow' in filter) return filter.allow.includes(name)
  return !filter.deny.includes(name)
}
