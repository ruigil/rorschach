import { createTopic, type ActorRef } from '../system/index.ts'

export type SCRKind = 'leaf' | 'reasoner' | 'graph' | 'operator'

export type SCRSchema = {
  inputSchema?: Record<string, any>
  outputSchema?: Record<string, any>
}

export type SCRInvokeMsg = {
  type: 'invoke'
  urn: string
  input: unknown
  replyTo: ActorRef<SCRReply>
}

export type SCRReply =
  | { type: 'result'; output: unknown }
  | { type: 'error'; error: string }
  | { type: 'pending'; jobId: string; placeholderText?: string }

export type SCRDescriptor = {
  urn: string
  kind: SCRKind
  description: string
  schema: SCRSchema
  tags?: string[]
  yieldsPending?: boolean
  target: ActorRef<any>
  /**
   * Optional metadata carrying extension properties for capabilities (e.g. schemas, model configs).
   */
  meta?: any
}

export type StreamLifecycleType = 'start' | 'chunk' | 'tools' | 'end' | 'error'

export type StreamChunk = {
  runId: string
  spanId: string
  parentSpanId?: string
  type: StreamLifecycleType
  chunk?: { kind: 'text' | 'reasoning'; text: string }
  tools?: Array<{ name: string; arguments?: string }>
  error?: string
}

export type SCRRegistrationEvent =
  | { type: 'register'; descriptor: SCRDescriptor }
  | { type: 'deregister'; urn: string }

export const SCRRegistrationTopic = createTopic<SCRRegistrationEvent>('scr.registration')

export type UsageUpdateEvent = {
  userId: string
  tokens: number
  costUsd: number
  traceId?: string
}

export const UsageUpdateTopic = createTopic<UsageUpdateEvent>('usage.update')

export type UserBudgetRecord = {
  userId: string
  tokensSpent: number
  costSpentUsd: number
  maxTokens?: number
  maxCostUsd?: number
}

export const UserBudgetTopic = createTopic<UserBudgetRecord>('user.budget')
