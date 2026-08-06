import type { PermissionContext } from '../../system/permissions/types.ts'
import type { AuthConfig } from './auth.config.ts'

export const DEFAULT_ROLE_GRANTS: Record<string, string[]> = {
  admin:     ["*"],
  user:      ["tools_*", "notebook_*", "memory_*", "googleapis_*", "workflows_*"],
  developer: ["coding_*"],
  guest:     ["tools_web_search"],
  anonymous: []
}

const uniqueRoles = (roles: readonly string[]): string[] => [...new Set(roles)]

const adminList = (value: string[] | string | undefined): string[] => {
  if (Array.isArray(value)) return value
  if (typeof value !== 'string') return []
  return value.split(/[\n,]/).map(item => item.trim()).filter(Boolean)
}

export const rolesForIdentity = (
  config: AuthConfig,
  identity: { userId?: string; fullName: string; phone?: string; roles?: readonly string[] },
): string[] => {
  const roles = [...(identity.roles ?? [])]
  const admins = config.admins
  const matched =
    adminList(admins?.usernames).includes(identity.fullName) ||
    (identity.phone ? adminList(admins?.phones).includes(identity.phone) : false) ||
    (identity.userId ? adminList(admins?.userIds).includes(identity.userId) : false)

  if (matched) roles.push('admin')
  return uniqueRoles(roles)
}

export const computePermissionContext = (
  config: AuthConfig,
  user: { fullName: string; roles?: string[]; permissions?: string[] },
): PermissionContext => {
  const perms = config.permissions ?? { roleDefaults: {} }
  const roles = rolesForIdentity(config, user)
  const grants = new Set<string>(user.permissions ?? [])
  
  for (const role of roles) {
    const roleGrants = perms.roleDefaults?.[role] ?? DEFAULT_ROLE_GRANTS[role] ?? []
    for (const g of roleGrants) {
      grants.add(g)
    }
  }
  
  return { grants: [...grants] }
}
