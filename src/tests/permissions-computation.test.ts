import { describe, expect, test } from 'bun:test'
import { computePermissionContext } from '../plugins/auth/permissions.ts'
import type { AuthConfig } from '../plugins/auth/authenticator.ts'

describe('Permissions Computation', () => {
  const baseConfig: AuthConfig = {
    rpId: 'localhost',
    rpName: 'Test RP',
    origin: 'http://localhost:3000',
    baseUrl: 'http://localhost:3000',
    sessionTtlMs: 3600000,
    challengeTtlMs: 60000,
    ticketTtlMs: 10000,
  }

  test('resolves default grants for anonymous and guest', () => {
    const ctxAnonymous = computePermissionContext(baseConfig, { fullName: 'Anon', roles: ['anonymous'] })
    expect(ctxAnonymous.grants).toEqual([])

    const ctxGuest = computePermissionContext(baseConfig, { fullName: 'Guest User', roles: ['guest'] })
    expect(ctxGuest.grants).toContain('tools_web_search')
  })

  test('resolves default grants for user and developer', () => {
    const ctxUser = computePermissionContext(baseConfig, { fullName: 'Alice', roles: ['user'] })
    expect(ctxUser.grants).toContain('tools_*')
    expect(ctxUser.grants).toContain('notebook_*')
    expect(ctxUser.grants).toContain('memory_*')
    expect(ctxUser.grants).toContain('googleapis_*')
    expect(ctxUser.grants).toContain('workflows_*')

    const ctxDev = computePermissionContext(baseConfig, { fullName: 'Bob', roles: ['developer'] })
    expect(ctxDev.grants).toContain('coding_*')
  })

  test('resolves custom permissions and merges them with role defaults', () => {
    const ctx = computePermissionContext(baseConfig, {
      fullName: 'Charlie',
      roles: ['guest'],
      permissions: ['notebook_journal_read', '!tools_web_search']
    })
    expect(ctx.grants).toContain('tools_web_search')
    expect(ctx.grants).toContain('notebook_journal_read')
    expect(ctx.grants).toContain('!tools_web_search')
  })

  test('overrides default roles using config permissions mapping', () => {
    const configWithOverrides: AuthConfig = {
      ...baseConfig,
      permissions: {
        roleDefaults: {
          guest: ['tools_file_fetch']
        }
      }
    }
    const ctx = computePermissionContext(configWithOverrides, { fullName: 'Dave', roles: ['guest'] })
    expect(ctx.grants).toEqual(['tools_file_fetch'])
    expect(ctx.grants).not.toContain('tools_web_search')
  })
})
