import type {
  Workflow,
  WorkflowArtifactRef,
  WorkflowOutputValue,
  WorkflowValueSpec,
} from './types.ts'

const VALUE_TYPES = new Set(['string', 'number', 'boolean', 'object', 'array', 'artifact'])

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

const isSpecRecord = (value: unknown): value is Record<string, WorkflowValueSpec> =>
  isRecord(value) && Object.values(value).every(isValueSpec)

const required = (spec: WorkflowValueSpec): boolean => spec.required !== false

const isValueSpec = (value: unknown): value is WorkflowValueSpec => {
  if (!isRecord(value) || typeof value.type !== 'string' || !VALUE_TYPES.has(value.type)) return false
  if (value.required !== undefined && typeof value.required !== 'boolean') return false
  if (value.description !== undefined && typeof value.description !== 'string') return false
  return true
}

const validateSpecMap = (label: string, value: unknown, errors: string[]): Record<string, WorkflowValueSpec> => {
  if (value === undefined) return {}
  if (!isRecord(value)) {
    errors.push(`${label} must be an object`)
    return {}
  }
  for (const [key, spec] of Object.entries(value)) {
    if (!key.trim()) errors.push(`${label} contains an empty key`)
    if (!isValueSpec(spec)) errors.push(`${label}.${key || '<empty>'} has an invalid value spec`)
  }
  return isSpecRecord(value) ? value : {}
}

const validateStringArray = (label: string, value: unknown, errors: string[]): string[] => {
  if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) {
    errors.push(`${label} must be an array of strings`)
    return []
  }
  const seen = new Set<string>()
  for (const item of value) {
    if (!item.trim()) errors.push(`${label} contains an empty value`)
    if (seen.has(item)) errors.push(`${label} contains duplicate value: ${item}`)
    seen.add(item)
  }
  return value
}

export const validateWorkflow = (workflow: Workflow): string[] => {
  const errors: string[] = []
  if (!workflow || typeof workflow !== 'object' || Array.isArray(workflow)) return ['workflow must be an object']
  if (typeof workflow.title !== 'string' || !workflow.title.trim()) errors.push('title must be a non-empty string')
  if (typeof workflow.goal !== 'string' || !workflow.goal.trim()) errors.push('goal must be a non-empty string')
  if (typeof workflow.context !== 'string' || !workflow.context.trim()) errors.push('context must be a non-empty string')
  const executionTools = validateStringArray('executionTools', workflow.executionTools, errors)
  validateSpecMap('inputs', workflow.inputs, errors)
  const workflowOutputs = validateSpecMap('outputs', workflow.outputs, errors)

  if (!Array.isArray(workflow.tasks) || workflow.tasks.length === 0) {
    errors.push('tasks must be a non-empty array')
    return errors
  }

  const taskIds = new Set<string>()
  const taskOutputOwners = new Map<string, string>()
  for (const task of workflow.tasks) {
    if (!isRecord(task)) {
      errors.push('tasks must contain objects')
      continue
    }
    if (typeof task.id !== 'string' || !task.id.trim()) errors.push('task.id must be a non-empty string')
    if (typeof task.name !== 'string' || !task.name.trim()) errors.push(`task ${String(task.id)} name must be a non-empty string`)
    if (typeof task.description !== 'string' || !task.description.trim()) errors.push(`task ${String(task.id)} description must be a non-empty string`)
    if (typeof task.validationCriteria !== 'string' || !task.validationCriteria.trim()) errors.push(`task ${String(task.id)} validationCriteria must be a non-empty string`)
    const dependencies = validateStringArray(`task ${String(task.id)} dependencies`, task.dependencies, errors)
    if (typeof task.id === 'string') {
      if (taskIds.has(task.id)) errors.push(`duplicate task id: ${task.id}`)
      taskIds.add(task.id)
    }
    const taskOutputs = validateSpecMap(`task ${String(task.id)} outputs`, task.outputs, errors)
    for (const key of Object.keys(taskOutputs)) {
      const owner = taskOutputOwners.get(key)
      if (owner) errors.push(`duplicate task output key: ${key} (${owner}, ${String(task.id)})`)
      else taskOutputOwners.set(key, String(task.id))
    }
    for (const dependency of dependencies) {
      if (dependency === task.id) errors.push(`task ${String(task.id)} cannot depend on itself`)
    }
  }

  for (const task of workflow.tasks) {
    if (!isRecord(task) || !Array.isArray(task.dependencies)) continue
    for (const dependency of task.dependencies) {
      if (typeof dependency === 'string' && !taskIds.has(dependency)) {
        errors.push(`task ${String(task.id)} dependency not found: ${dependency}`)
      }
    }
  }

  const visiting = new Set<string>()
  const visited = new Set<string>()
  const byId = new Map(workflow.tasks.filter(task => typeof task.id === 'string').map(task => [task.id, task]))
  const visit = (taskId: string): boolean => {
    if (visited.has(taskId)) return false
    if (visiting.has(taskId)) return true
    visiting.add(taskId)
    const task = byId.get(taskId)
    const hasCycle = !!task?.dependencies.some(depId => typeof depId === 'string' && byId.has(depId) && visit(depId))
    visiting.delete(taskId)
    visited.add(taskId)
    return hasCycle
  }
  if ([...byId.keys()].some(visit)) errors.push('workflow dependency graph must be acyclic')

  for (const key of Object.keys(workflowOutputs)) {
    if (!taskOutputOwners.has(key)) errors.push(`workflow output is not declared by any task output: ${key}`)
  }
  return errors
}

export const validateInputValues = (
  specs: Record<string, WorkflowValueSpec> | undefined,
  values: Record<string, unknown> | undefined,
): { ok: true; values: Record<string, unknown> } | { ok: false; error: string } => {
  const inputSpecs = specs ?? {}
  const inputs = values ?? {}
  if (!isRecord(inputs)) return { ok: false, error: 'inputs must be an object' }
  for (const key of Object.keys(inputs)) {
    if (!inputSpecs[key]) return { ok: false, error: `unknown workflow input: ${key}` }
  }
  for (const [key, spec] of Object.entries(inputSpecs)) {
    if (inputs[key] === undefined) {
      if (required(spec)) return { ok: false, error: `missing required workflow input: ${key}` }
      continue
    }
    const error = validateValue(key, spec, inputs[key])
    if (error) return { ok: false, error }
  }
  return { ok: true, values: inputs }
}

export const validateOutputValues = (
  label: string,
  specs: Record<string, WorkflowValueSpec> | undefined,
  values: Record<string, unknown>,
): { ok: true; values: Record<string, WorkflowOutputValue> } | { ok: false; error: string } => {
  const outputSpecs = specs ?? {}
  if (!isRecord(values)) return { ok: false, error: `${label} outputs must be an object` }
  for (const key of Object.keys(values)) {
    if (!outputSpecs[key]) return { ok: false, error: `${label} output is not declared: ${key}` }
  }
  for (const [key, spec] of Object.entries(outputSpecs)) {
    if (values[key] === undefined) {
      if (required(spec)) return { ok: false, error: `${label} missing required output: ${key}` }
      continue
    }
    const error = validateValue(`${label}.${key}`, spec, values[key])
    if (error) return { ok: false, error }
  }
  return { ok: true, values: values as Record<string, WorkflowOutputValue> }
}

export const validArtifactPath = (path: string): boolean => {
  if (!path || path.includes('\0') || path.startsWith('/') || path.includes('\\')) return false
  const parts = path.split('/')
  return parts.every(part => part && part !== '.' && part !== '..')
}

export const validArtifactUrl = (url: string): boolean => {
  if (!url || /[\0-\x1f\x7f]/.test(url) || url.includes('\\')) return false
  const rawPath = url.split(/[?#]/, 1)[0] ?? ''
  if (!rawPath) return false
  let decodedRawPath = rawPath
  try {
    decodedRawPath = decodeURIComponent(rawPath)
  } catch {
    return false
  }
  if (decodedRawPath.split('/').some(part => part === '..')) return false
  try {
    const parsed = new URL(url, 'http://rorschach.local')
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
    if (parsed.username || parsed.password) return false
    const isRelative = !/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(url)
    if (isRelative && (url.startsWith('//') || parsed.origin !== 'http://rorschach.local')) return false
    return parsed.pathname.split('/').every(part => part !== '..')
  } catch {
    return false
  }
}

export const isArtifactRef = (value: unknown): value is WorkflowArtifactRef =>
  isRecord(value) &&
  value.type === 'artifact' &&
  (
    (typeof value.key === 'string' && value.url === undefined && validArtifactPath(value.key)) ||
    (typeof value.url === 'string' && value.key === undefined && validArtifactUrl(value.url))
  ) &&
  (value.mimeType === undefined || typeof value.mimeType === 'string') &&
  (value.name === undefined || typeof value.name === 'string')

export const isRunArtifactRef = (value: unknown): value is Extract<WorkflowArtifactRef, { key: string }> =>
  isArtifactRef(value) && 'key' in value

const validateValue = (label: string, spec: WorkflowValueSpec, value: unknown): string | null => {
  switch (spec.type) {
    case 'string':
      return typeof value === 'string' ? null : `${label} must be a string`
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) ? null : `${label} must be a finite number`
    case 'boolean':
      return typeof value === 'boolean' ? null : `${label} must be a boolean`
    case 'object':
      return isRecord(value) && !isArtifactRef(value) ? null : `${label} must be an object`
    case 'array':
      return Array.isArray(value) ? null : `${label} must be an array`
    case 'artifact':
      return isArtifactRef(value) ? null : `${label} must be an artifact reference with either a safe relative path or a public URL`
  }
}
