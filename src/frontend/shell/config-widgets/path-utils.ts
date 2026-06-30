// Shared helpers for resolving nested config-key paths.
//
// Config schemas use dotted paths (e.g. "memory.graph") to address nested
// objects. These helpers read, write, and resolve values at those paths
// within a plugin's value tree, replacing the duplicated path-string logic
// that was inlined in the original r-config-form.ts.

export type ConfigValues = Record<string, any>

/** Navigate to the object at `configKey` (dotted path) within `values`,
 *  creating intermediate objects as needed. Returns the parent object that
 *  holds the leaf key. */
export function resolvePath(values: ConfigValues, configKey: string): ConfigValues {
  let target = values
  if (configKey) {
    for (const part of configKey.split('.')) {
      target = target[part] ??= {}
    }
  }
  return target
}

/** Read the value at `configKey.key` within `values`, or `undefined`. */
export function readAtPath(values: ConfigValues, configKey: string, key: string): any {
  let target = values
  if (configKey) {
    for (const part of configKey.split('.')) {
      target = target?.[part]
      if (target === undefined) return undefined
    }
  }
  return target?.[key]
}

/** Write `value` at `configKey.key` within `values`, mutating in place. */
export function writeAtPath(values: ConfigValues, configKey: string, key: string, value: any): void {
  const target = resolvePath(values, configKey)
  target[key] = value
}

/** Derive the plugin id from a section id (the part before the first dot). */
export function pluginIdFromSection(sectionId: string): string {
  return sectionId.split('.')[0]!
}

/** Compose the next-level config key when recursing into a sub-object. */
export function childConfigKey(parentKey: string, childKey: string): string {
  return parentKey ? `${parentKey}.${childKey}` : childKey
}
