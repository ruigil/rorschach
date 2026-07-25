// src/system/permissions/evaluator.ts
import type { PermissionContext } from './types.ts'
import { isInfrastructureCallback } from './system-tools.ts'

export const authorize = (ctx: PermissionContext, toolName: string): boolean => {
  if (isInfrastructureCallback(toolName)) return true
  return matchesGrants(ctx.grants, toolName)
}

export const matchesGrants = (grants: string[], toolName: string): boolean => {
  let allowed = false
  for (const grant of grants) {
    if (grant.startsWith('!')) {
      if (matchPattern(grant.slice(1), toolName)) {
        return false // Deny immediately
      }
    } else if (!allowed && matchPattern(grant, toolName)) {
      allowed = true // Allowed flag is set, but keep checking for subsequent denials
    }
  }
  return allowed
}

const matchPattern = (pattern: string, toolName: string): boolean => {
  if (pattern === '*') return true
  if (pattern.endsWith('*')) return toolName.startsWith(pattern.slice(0, -1))
  return pattern === toolName
}
