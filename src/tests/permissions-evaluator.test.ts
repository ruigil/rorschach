// src/tests/permissions-evaluator.test.ts
import { describe, expect, test } from 'bun:test'
import { authorize } from '../system/permissions/evaluator.ts'
import type { PermissionContext } from '../system/permissions/types.ts'

describe('Permissions Evaluator', () => {
  test('allows infrastructure callbacks unconditionally', () => {
    const ctx: PermissionContext = { grants: [] }
    expect(authorize(ctx, 'workflows_task_complete')).toBe(true)
    expect(authorize(ctx, 'workflows_task_block')).toBe(true)
  })

  test('blocks non-infrastructure tools if grants are empty', () => {
    const ctx: PermissionContext = { grants: [] }
    expect(authorize(ctx, 'coding_shell_exec')).toBe(false)
    expect(authorize(ctx, 'memory_recall')).toBe(false)
  })

  test('allows exact matches', () => {
    const ctx: PermissionContext = { grants: ['coding_shell_exec', 'memory_recall'] }
    expect(authorize(ctx, 'coding_shell_exec')).toBe(true)
    expect(authorize(ctx, 'memory_recall')).toBe(true)
    expect(authorize(ctx, 'tools_web_search')).toBe(false)
  })

  test('allows wildcard matches', () => {
    const ctx: PermissionContext = { grants: ['coding_*'] }
    expect(authorize(ctx, 'coding_shell_exec')).toBe(true)
    expect(authorize(ctx, 'coding_file_read')).toBe(true)
    expect(authorize(ctx, 'memory_recall')).toBe(false)
  })

  test('allows global wildcard match (*)', () => {
    const ctx: PermissionContext = { grants: ['*'] }
    expect(authorize(ctx, 'coding_shell_exec')).toBe(true)
    expect(authorize(ctx, 'memory_recall')).toBe(true)
    expect(authorize(ctx, 'tools_web_search')).toBe(true)
  })

  test('enforces exact negation (denial)', () => {
    const ctx1: PermissionContext = { grants: ['*', '!coding_shell_exec'] }
    expect(authorize(ctx1, 'coding_shell_exec')).toBe(false)
    expect(authorize(ctx1, 'memory_recall')).toBe(true)

    const ctx2: PermissionContext = { grants: ['coding_*', '!coding_shell_exec'] }
    expect(authorize(ctx2, 'coding_shell_exec')).toBe(false)
    expect(authorize(ctx2, 'coding_file_read')).toBe(true)
  })

  test('enforces wildcard negation', () => {
    const ctx: PermissionContext = { grants: ['*', '!coding_*'] }
    expect(authorize(ctx, 'coding_shell_exec')).toBe(false)
    expect(authorize(ctx, 'coding_file_read')).toBe(false)
    expect(authorize(ctx, 'memory_recall')).toBe(true)
  })

  test('evaluates in sequence where negation wins', () => {
    // If negation is placed first or last, negation should win.
    const ctx1: PermissionContext = { grants: ['!coding_shell_exec', 'coding_*'] }
    expect(authorize(ctx1, 'coding_shell_exec')).toBe(false)
    expect(authorize(ctx1, 'coding_file_read')).toBe(true)

    const ctx2: PermissionContext = { grants: ['coding_*', '!coding_shell_exec'] }
    expect(authorize(ctx2, 'coding_shell_exec')).toBe(false)
    expect(authorize(ctx2, 'coding_file_read')).toBe(true)
  })
})
