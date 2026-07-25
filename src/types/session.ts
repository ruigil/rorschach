import { createTopic } from '../system/index.ts'
import type { ActorRef } from '../system/index.ts'
import type { PermissionContext } from '../system/permissions/types.ts'

// ─── Session lifecycle (shared across auth, cognitive, http) ───

export type SessionLifecycleEvent =
  | {
      type: 'sessionStarted'
      userId: string
      defaultMode: string
      contextStoreRef: ActorRef<any>
      permissionContext?: PermissionContext
      timestamp: number
    }
  | {
      type: 'sessionEnded'
      userId: string
      reason: 'lastDisconnect' | 'contextStoreCrash'
      timestamp: number
    }
  | {
      type: 'modeActivated'
      userId: string
      mode: string
      previousMode: string
      source: 'user' | 'llm' | 'programmatic' | 'crashFallback'
      timestamp: number
    }
  | {
      type: 'presencePresent'
      userId: string
      source: 'http' | 'signal' | 'cli'
      timestamp: number
    }
  | {
      type: 'presenceAbsent'
      userId: string
      source: 'http' | 'signal' | 'cli'
      timestamp: number
    }
  | {
      type: 'sessionInvalidated'
      userId: string
      permissionContext: PermissionContext
      timestamp: number
    }

export const SessionLifecycleTopic = createTopic<SessionLifecycleEvent>('session.lifecycle')
