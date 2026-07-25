// src/system/permissions/system-tools.ts

export const INFRASTRUCTURE_CALLBACKS: ReadonlySet<string> = new Set([
  'cognitive_switch_mode',
  'workflows_task_complete',
  'workflows_task_block',
])

export const isInfrastructureCallback = (name: string): boolean =>
  INFRASTRUCTURE_CALLBACKS.has(name)
