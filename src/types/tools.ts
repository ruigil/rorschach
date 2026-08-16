import { createTopic, type ActorRef } from '../system/index.ts'
import type { MessageAttachment } from './events.ts'
import type { PermissionContext } from '../system/permissions/types.ts'

// ─── Schema (what the LLM sees) ───

export type ToolSchema = {
  type: 'function'
  function: { name: string; description: string; parameters: object }
}

// ─── Generic tool protocol ───

export type ToolSource = { title: string; url: string; snippet: string }

export type ToolResultPayload = {
  text:         string
  sources?:     ToolSource[]
  attachments?: MessageAttachment[]
}

// ─── Job registry (for long-running jobs) ───

export type JobLifecycleEvent =
  | {
      jobId: string
      status: 'running'
      toolName: string
      toolRef: ActorRef<any>
      startedAt: number
      userId?: string
      statusText?: string
      progress?: { current: number; total: number }
    }
  | { jobId: string; status: 'completed'; result: ToolResultPayload; statusText?: string }
  | { jobId: string; status: 'failed';    error: string }
  | { jobId: string; status: 'cleared' }

export const JobRegistryTopic = createTopic<JobLifecycleEvent>('tools.jobs')
