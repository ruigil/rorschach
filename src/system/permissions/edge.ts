import type { HttpWsFrameEvent } from '../../types/events.ts'
import type { PermissionContext } from './types.ts'
import { authorize } from './evaluator.ts'

const DISABLED: PermissionContext = { grants: ['*'] }

export const gateWsFrame = (
  event: Pick<HttpWsFrameEvent, 'userId' | 'permission'>,
  requiredTool: string,
  logger?: { warn: (msg: string, meta?: any) => void },
  surface?: string,
): boolean => {
  const allowed = authorize(event.permission ?? DISABLED, requiredTool)
  if (!allowed && logger) {
    logger.warn('websocket frame authorization denied', {
      event: 'permission_denied',
      userId: event.userId,
      toolName: requiredTool,
      surface: surface ?? 'ws_edge',
      reason: 'missing_grant',
    })
  }
  return allowed
}
