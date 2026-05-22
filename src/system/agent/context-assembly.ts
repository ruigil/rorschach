import type { ApiMessage } from '../../types/llm.ts'
import type { ContextSnapshotEvent, ToolSummary } from '../../types/agents.ts'

export type ContextView = Pick<
  ContextSnapshotEvent,
  'userId' | 'version' | 'recentMessages' | 'userContext' | 'modeSummaries' | 'toolSummaries'
>

export type ContextAssemblyPolicy = {
  mode: string
  systemPrompt: string
  includeUserContext?: boolean
  includeCurrentModeSummary?: boolean
  includeOtherModeSummaries?: boolean
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

const renderModeSummaries = (
  summaries: Record<string, string>,
  mode: string,
  includeCurrent: boolean,
  includeOther: boolean,
): string => {
  const parts: string[] = []
  for (const [summaryMode, summary] of Object.entries(summaries)) {
    if (summaryMode === mode && !includeCurrent) continue
    if (summaryMode !== mode && !includeOther) continue
    const text = summary.trim()
    if (text) parts.push(`${summaryMode}: ${text}`)
  }
  return parts.join('\n\n')
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
  const recentLimit = policy.recentMessageLimit ?? 40
  const toolLimit = policy.toolSummaryLimit ?? 8

  const recent = view.recentMessages.slice(-recentLimit)
  const withoutCurrent = recent.at(-1) && sameMessage(recent.at(-1)!, currentUserMessage)
    ? recent.slice(0, -1)
    : recent

  const notes = [
    policy.includeUserContext === false ? null : contextNote('User context', view.userContext ?? ''),
    contextNote(
      'Mode context',
      renderModeSummaries(
        view.modeSummaries,
        policy.mode,
        policy.includeCurrentModeSummary !== false,
        policy.includeOtherModeSummaries === true,
      ),
    ),
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

