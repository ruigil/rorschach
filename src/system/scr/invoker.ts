import { ask } from '../actor/ask.ts'
import { ResolutionCache } from './cache.ts'
import type { SCRReply, SCRInvokeMsg } from '../../types/scr.ts'
import { requestStorage, createMessageRequest } from '../context/request.ts'
import { authorize } from '../permissions/evaluator.ts'
import type { PermissionContext } from '../permissions/types.ts'
import type { MessageRequest } from '../context/request.ts'
import { validateSchema } from '../schema-validator.ts'
import type { ToolMsg, ToolReply } from '../../types/tools.ts'

const checkPermission = (permissionContext: PermissionContext, urn: string): boolean => {
  if (authorize(permissionContext, urn)) return true

  // Parse namespace and name from URN to check legacy permission formats (e.g. tools_web_search)
  const parts = urn.split(':')
  if (parts.length >= 3) {
    const canonicalName = parts.slice(2).join(':') // e.g. tools.web_search
    if (authorize(permissionContext, canonicalName)) return true
    
    const underscoreName = canonicalName.replace(/\./g, '_')
    if (authorize(permissionContext, underscoreName)) return true
  }

  return false
}

export const invokeSCR = async (
  urn: string,
  input: unknown
): Promise<SCRReply> => {
  const ambient = requestStorage.getStore() || createMessageRequest()
  const nextDepth = (ambient.depth ?? 0) + 1
  const maxDepth = ambient.maxDepth ?? 10

  if (nextDepth > maxDepth) {
    return {
      type: 'error',
      error: `Max recursion depth of ${maxDepth} exceeded`,
    }
  }

  // Budget validation
  const userId = ambient.userId || 'system'
  const budget = ResolutionCache.getBudget(userId)
  if (budget) {
    if (budget.maxTokens !== undefined && budget.tokensSpent >= budget.maxTokens) {
      return {
        type: 'error',
        error: `User budget exceeded: token limit of ${budget.maxTokens} reached (${budget.tokensSpent} spent)`,
      }
    }
    if (budget.maxCostUsd !== undefined && budget.costSpentUsd >= budget.maxCostUsd) {
      return {
        type: 'error',
        error: `User budget exceeded: cost limit of $${budget.maxCostUsd} reached ($${budget.costSpentUsd} spent)`,
      }
    }
  }

  // Permission validation
  const permissionContext = ambient.permission ?? { grants: ['*'] }
  if (!checkPermission(permissionContext, urn)) {
    return {
      type: 'error',
      error: `Unauthorized: User not authorized to invoke URN ${urn}`,
    }
  }

  // Capability resolution
  const descriptor = ResolutionCache.getDescriptor(urn)
  if (!descriptor) {
    return {
      type: 'error',
      error: `Capability not found: ${urn}`,
    }
  }

  // Input Schema Validation Membrane (Task 2.2)
  if (descriptor.schema?.inputSchema) {
    const errors = validateSchema(descriptor.schema.inputSchema, input)
    if (errors.length > 0) {
      return {
        type: 'error',
        error: `Input validation failed: ${errors.join(', ')}`,
      }
    }
  }

  const nextRequest: MessageRequest = {
    ...ambient,
    depth: nextDepth,
  }

  try {
    const reply = await requestStorage.run(nextRequest, () => {
      return ask<SCRInvokeMsg, SCRReply>(
        descriptor.target,
        (replyTo) => ({
          type: 'invoke',
          urn,
          input,
          replyTo,
        }),
        { timeoutMs: 60_000 },
        nextRequest
      )
    })

    if (descriptor.kind === 'leaf' && reply.type === 'result') {
      if (descriptor.schema?.outputSchema) {
        const errors = validateSchema(descriptor.schema.outputSchema, reply.output)
        if (errors.length > 0) {
          return {
            type: 'error',
            error: `Output validation failed: ${errors.join(', ')}`,
          }
        }
      }
    }

    return reply
  } catch (err: any) {
    return {
      type: 'error',
      error: err?.message || String(err),
    }
  }
}
