import type { ApiMessage } from '../../types/llm.ts'
import type { ContextSnapshotEvent, ToolSummary } from '../../types/agents.ts'
import type { MessageAttachment } from '../../types/events.ts'

export const assembleUserText = (
  text:         string,
  attachments?: MessageAttachment[],
): string => {
  let out = text
  if (!attachments || attachments.length === 0) return out

  const images = attachments.filter(a => a.kind === 'image').map(a => a.url)
  if (images.length > 0) {
    const note = images.length === 1
      ? `[Image attached: "${images[0]}"] `
      : `[Images attached: ${images.map(p => `"${p}"`).join(', ')}]`
    out = out ? `${out}\n\n${note}` : note
  }

  const audio = attachments.filter(a => a.kind === 'audio').map(a => a.url)
  if (audio.length > 0) {
    const note = audio.length === 1
      ? `[Audio attached: "${audio[0]}"]`
      : `[Audio files attached: ${audio.map(p => `"${p}"`).join(', ')}]`
    out = out ? `${out}\n\n${note}` : note
  }

  const pdfs = attachments.filter(a => a.kind === 'pdf').map(a => a.url)
  if (pdfs.length > 0) {
    const note = pdfs.length === 1
      ? `[PDF attached: "${pdfs[0]}"] `
      : `[PDFs attached: ${pdfs.map(p => `"${p}"`).join(', ')}]`
    out = out ? `${out}\n\n${note}` : note
  }

  return out
}

export type ContextView = Pick<
  ContextSnapshotEvent,
  'userId' | 'version' | 'recentMessages' | 'userContext' | 'toolSummaries' | 'timezone'
>

export type ContextAssemblyPolicy = {
  mode: string
  systemPrompt: string
  includeToolSummaries?: boolean
  recentMessageLimit?: number
  toolSummaryLimit?: number
}

const HISTORY_MARKERS_NOTE =
  'Messages prefixed with [Job · <tool>] are system-delivered background completions ' +
  'from that tool (scheduled tasks, long-running work, and similar). They appear as ' +
  'user messages but were not written or initiated by the user. Respond to the ' +
  'content naturally, but do not imply the user just said or requested it ' +
  '(e.g. avoid “Thanks for asking…” / “As you requested…”). Do not restate the ' +
  '[Job · …] marker.'

const sameMessage = (a: ApiMessage, b: ApiMessage): boolean =>
  a.role === b.role && JSON.stringify(a.content) === JSON.stringify(b.content)

const contextNote = (label: string, content: string): ApiMessage | null => {
  const text = content.trim()
  return text ? { role: 'system', content: `${label}:\n${text}` } : null
}



const renderToolSummaries = (summaries: ToolSummary[], mode: string, limit: number): string => {
  const selected = summaries
    .filter(summary => summary.mode === mode)
    .slice(-limit)

  return selected
    .map(summary => `[${summary.toolName}] ${summary.summary}`)
    .join('\n')
}

export const assembleAgentMessages = (
  view: ContextView,
  policy: ContextAssemblyPolicy,
  currentUserMessage: ApiMessage,
): ApiMessage[] => {
  const recentLimit = policy.recentMessageLimit ?? Infinity
  const toolLimit = policy.toolSummaryLimit ?? 8

  const recent = view.recentMessages.slice(-recentLimit)
  const withoutCurrent = recent.at(-1) && sameMessage(recent.at(-1)!, currentUserMessage)
    ? recent.slice(0, -1)
    : recent

  const notes = [
    contextNote('User context', view.userContext ?? ''),

    policy.includeToolSummaries === false
      ? null
      : contextNote('Recent tool results', renderToolSummaries(view.toolSummaries, policy.mode, toolLimit)),
  ].filter((message): message is ApiMessage => message !== null)

  const systemPrompt = [policy.systemPrompt, HISTORY_MARKERS_NOTE].filter(Boolean).join('\n\n---\n\n')

  return [
    { role: 'system', content: systemPrompt },
    ...notes,
    ...withoutCurrent,
    currentUserMessage,
  ]
}

export const getTodayDateString = (format: 'iso' | 'local' = 'local'): string => {
  if (format === 'iso') {
    return new Date().toISOString().slice(0, 10)
  }
  return new Date().toDateString()
}

export type UserTimeContext = {
  iso: string
  formatted: string
  timezone: string
  offset: string
  dayOfWeek: string
}

export const isValidTimezone = (tz: string): boolean => {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz })
    return true
  } catch {
    return false
  }
}

export const getUserTimeContext = (timezone?: string, date = new Date()): UserTimeContext => {
  const resolvedTz = timezone && isValidTimezone(timezone)
    ? timezone
    : (Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC')

  let offset = 'Z'
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: resolvedTz, timeZoneName: 'longOffset' }).formatToParts(date)
    const tzPart = parts.find(p => p.type === 'timeZoneName')?.value
    if (tzPart) {
      const match = tzPart.match(/GMT([+-]\d{1,2}):?(\d{2})?/)
      if (match) {
        const sign = match[1]!.startsWith('+') ? '+' : '-'
        const hours = Math.abs(parseInt(match[1]!, 10)).toString().padStart(2, '0')
        const mins = match[2] || '00'
        offset = `${sign}${hours}:${mins}`
      } else if (tzPart === 'GMT') {
        offset = '+00:00'
      }
    }
  } catch {
    offset = 'Z'
  }

  let iso = date.toISOString()
  try {
    const year = new Intl.DateTimeFormat('en-US', { timeZone: resolvedTz, year: 'numeric' }).format(date)
    const month = new Intl.DateTimeFormat('en-US', { timeZone: resolvedTz, month: '2-digit' }).format(date)
    const day = new Intl.DateTimeFormat('en-US', { timeZone: resolvedTz, day: '2-digit' }).format(date)
    const hour = new Intl.DateTimeFormat('en-US', { timeZone: resolvedTz, hour: '2-digit', hour12: false }).format(date)
    const minute = new Intl.DateTimeFormat('en-US', { timeZone: resolvedTz, minute: '2-digit' }).format(date)
    const second = new Intl.DateTimeFormat('en-US', { timeZone: resolvedTz, second: '2-digit' }).format(date)
    
    let cleanHour = hour.trim()
    if (cleanHour === '24') cleanHour = '00'
    else if (cleanHour.length === 1) cleanHour = `0${cleanHour}`

    iso = `${year}-${month}-${day}T${cleanHour}:${minute}:${second}${offset === 'Z' ? '+00:00' : offset}`
  } catch {
    iso = date.toISOString()
  }

  const formatted = date.toLocaleString('en-US', {
    timeZone: resolvedTz,
    dateStyle: 'full',
    timeStyle: 'medium',
  })
  
  const dayOfWeek = date.toLocaleString('en-US', {
    timeZone: resolvedTz,
    weekday: 'long',
  })

  return {
    iso,
    formatted,
    timezone: resolvedTz,
    offset,
    dayOfWeek,
  }
}


