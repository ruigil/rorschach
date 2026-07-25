import type { PermissionContext } from '../../system/permissions/types.ts'
import type { AuthConfig } from './authenticator.ts'
import { rolesForIdentity } from './authenticator.ts'

export const DEFAULT_ROLE_GRANTS: Record<string, string[]> = {
  admin:     ["*"],
  user:      ["tools_*", "notebook_*", "memory_*", "googleapis_*", "workflows_*"],
  developer: ["coding_*"],
  guest:     ["tools_web_search"],
  anonymous: []
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
