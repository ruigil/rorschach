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
  'userId' | 'version' | 'recentMessages' | 'userContext' | 'toolSummaries'
>

export type ContextAssemblyPolicy = {
  mode: string
  systemPrompt: string
  includeToolSummaries?: boolean
  recentMessageLimit?: number
  toolSummaryLimit?: number
}

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

  return [
    { role: 'system', content: policy.systemPrompt },
    ...notes,
    ...withoutCurrent,
    currentUserMessage,
  ]
}

