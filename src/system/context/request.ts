import { AsyncLocalStorage } from 'node:async_hooks'
import type { PermissionContext } from '../permissions/types.ts'

export const requestStorage = new AsyncLocalStorage<MessageRequest>()


export type MessageRequest = {
  /** Distributed tracing & correlation ids */
  readonly traceId: string
  readonly spanId?: string
  readonly parentSpanId?: string

  /** Authenticated user identity. Never undefined — defaults to 'system'/'anonymous' ingress actors. */
  readonly userId: string
  readonly roles?: string[]

  /** Security policy & permission grants */
  readonly permission?: PermissionContext

  /** Ingress & client environment metadata */
  readonly clientId?: string
  readonly timezone?: string
  readonly source?: 'http' | 'websocket' | 'signal' | 'cli' | 'system' | (string & {})

  /** Key-value baggage for tracing extensions */
  readonly baggage?: Record<string, string>
}

// ─── Standard Proxy-Friendly Header Keys ───
export const HEADER_TRACEPARENT = 'traceparent'
export const HEADER_USER_ID = 'x-user-id'
export const HEADER_USER_ROLES = 'x-user-roles'
export const HEADER_PERMISSIONS = 'x-user-permissions'
export const HEADER_CLIENT_ID = 'x-client-id'
export const HEADER_TIMEZONE = 'x-timezone'
export const HEADER_SOURCE = 'x-client-source'
export const HEADER_MESSAGE_REQUEST = 'x-message-request'

/**
 * Helper to determine if an object is a MessageRequest vs raw MessageHeaders string record.
 */
export const isMessageRequest = (obj: any): boolean => {
  if (!obj || typeof obj !== 'object') return false
  return (
    'userId' in obj ||
    'permission' in obj ||
    'roles' in obj ||
    'source' in obj ||
    'clientId' in obj ||
    'timezone' in obj ||
    'parentSpanId' in obj ||
    ('traceId' in obj && typeof obj.traceId === 'string' && !('traceparent' in obj))
  )
}

/**
 * Creates a default system MessageRequest object (e.g. for background timers or system init).
 */
export const createMessageRequest = (partial?: Partial<MessageRequest>): MessageRequest => {
  return {
    traceId: partial?.traceId || crypto.randomUUID().replace(/-/g, ''),
    spanId: partial?.spanId || crypto.randomUUID().replace(/-/g, '').slice(0, 16),
    parentSpanId: partial?.parentSpanId,
    userId: partial?.userId || 'system',
    roles: partial?.roles || ['system'],
    permission: partial?.permission || { grants: ['*'] },
    clientId: partial?.clientId,
    timezone: partial?.timezone,
    source: partial?.source || 'system',
    baggage: partial?.baggage,
  }
}

/**
 * Encodes a MessageRequest object into standard headers (Record<string, string>).
 */
export const encodeMessageRequest = (
  req: Partial<MessageRequest>,
  baseHeaders: Record<string, string> = {}
): Record<string, string> => {
  const headers: Record<string, string> = { ...baseHeaders }

  if (req.traceId) {
    const spanId = req.spanId || '0000000000000000'
    headers[HEADER_TRACEPARENT] = `00-${req.traceId}-${spanId}-01`
  }
  if (req.userId) headers[HEADER_USER_ID] = req.userId
  if (req.roles && req.roles.length > 0) headers[HEADER_USER_ROLES] = req.roles.join(',')
  if (req.clientId) headers[HEADER_CLIENT_ID] = req.clientId
  if (req.timezone) headers[HEADER_TIMEZONE] = req.timezone
  if (req.source) headers[HEADER_SOURCE] = req.source

  if (req.permission) {
    headers[HEADER_PERMISSIONS] = JSON.stringify(req.permission)
  }

  // Packed header for loss-free remote boundary transmission
  headers[HEADER_MESSAGE_REQUEST] = JSON.stringify({
    traceId: req.traceId,
    spanId: req.spanId,
    parentSpanId: req.parentSpanId,
    userId: req.userId,
    roles: req.roles,
    permission: req.permission,
    clientId: req.clientId,
    timezone: req.timezone,
    source: req.source,
    baggage: req.baggage,
  })

  return headers
}

/**
 * Decodes standard headers (Record<string, string>) into a strongly-typed MessageRequest object.
 */
export const decodeMessageRequest = (headers: Record<string, string> = {}): MessageRequest => {
  if (isMessageRequest(headers)) {
    return headers as unknown as MessageRequest
  }

  if (headers[HEADER_MESSAGE_REQUEST]) {
    try {
      const raw = JSON.parse(headers[HEADER_MESSAGE_REQUEST])
      return {
        traceId: raw.traceId || extractTraceId(headers[HEADER_TRACEPARENT]) || crypto.randomUUID().replace(/-/g, ''),
        spanId: raw.spanId || extractSpanId(headers[HEADER_TRACEPARENT]),
        parentSpanId: raw.parentSpanId,
        userId: raw.userId || headers[HEADER_USER_ID] || 'system',
        roles: raw.roles || (headers[HEADER_USER_ROLES] ? headers[HEADER_USER_ROLES].split(',') : undefined),
        permission: raw.permission || parsePermissions(headers[HEADER_PERMISSIONS]),
        clientId: raw.clientId || headers[HEADER_CLIENT_ID],
        timezone: raw.timezone || headers[HEADER_TIMEZONE],
        source: raw.source || headers[HEADER_SOURCE] || 'system',
        baggage: raw.baggage,
      }
    } catch {
      // Fall through
    }
  }

  const traceId = extractTraceId(headers[HEADER_TRACEPARENT]) || crypto.randomUUID().replace(/-/g, '')
  const spanId = extractSpanId(headers[HEADER_TRACEPARENT])
  const userId = headers[HEADER_USER_ID] || 'system'
  const roles = headers[HEADER_USER_ROLES] ? headers[HEADER_USER_ROLES].split(',') : undefined
  const permission = parsePermissions(headers[HEADER_PERMISSIONS])
  const clientId = headers[HEADER_CLIENT_ID]
  const timezone = headers[HEADER_TIMEZONE]
  const source = headers[HEADER_SOURCE] || 'system'

  return {
    traceId,
    spanId,
    userId,
    roles,
    permission,
    clientId,
    timezone,
    source,
  }
}

const extractTraceId = (traceparent?: string): string | undefined => {
  if (!traceparent) return undefined
  const parts = traceparent.split('-')
  return parts.length >= 4 ? parts[1] : undefined
}

const extractSpanId = (traceparent?: string): string | undefined => {
  if (!traceparent) return undefined
  const parts = traceparent.split('-')
  return parts.length >= 4 ? parts[2] : undefined
}

const parsePermissions = (raw?: string): PermissionContext | undefined => {
  if (!raw) return undefined
  try {
    if (raw.startsWith('{')) return JSON.parse(raw)
    return { grants: raw.split(',') }
  } catch {
    return undefined
  }
}
