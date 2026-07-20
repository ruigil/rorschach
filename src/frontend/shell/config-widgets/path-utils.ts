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

export type ConfigTreeNode = {
  id: string
  label: string
  subtitle?: string
  type: 'group' | 'section'
  tab?: string
  children?: ConfigTreeNode[]
  section?: any
}

export function buildConfigTree(schemas: Array<{ id: string; tab: string; title: string; subtitle?: string; schema: any }>): ConfigTreeNode[] {
  const byTab: Record<string, any[]> = {}
  for (const s of schemas) {
    (byTab[s.tab] ??= []).push(s)
  }

  const nodes: ConfigTreeNode[] = []
  for (const [tab, sections] of Object.entries(byTab)) {
    nodes.push({
      id: `group:${tab}`,
      label: tab.charAt(0).toUpperCase() + tab.slice(1),
      type: 'group',
      tab,
      children: sections.map(s => ({
        id: s.id,
        label: s.title,
        subtitle: s.subtitle,
        type: 'section',
        tab: s.tab,
        section: s
      }))
    })
  }

  return nodes
}

export function filterConfigTree(nodes: ConfigTreeNode[], query: string): { filteredNodes: ConfigTreeNode[]; autoExpandIds: Set<string> } {
  if (!query.trim()) return { filteredNodes: nodes, autoExpandIds: new Set() }
  const q = query.toLowerCase().trim()
  const autoExpandIds = new Set<string>()

  function matchSection(s: any): boolean {
    if (s.title?.toLowerCase().includes(q)) return true
    if (s.subtitle?.toLowerCase().includes(q)) return true
    if (s.id?.toLowerCase().includes(q)) return true
    const props = s.schema?.properties || {}
    for (const [key, prop] of Object.entries<any>(props)) {
      if (key.toLowerCase().includes(q)) return true;
      if (prop?.['x-ui']?.label?.toLowerCase().includes(q)) return true;
    }
    return false
  }

  function filterNodes(nodeList: ConfigTreeNode[]): ConfigTreeNode[] {
    const result: ConfigTreeNode[] = []
    for (const node of nodeList) {
      if (node.type === 'section') {
        if (node.label.toLowerCase().includes(q) || (node.section && matchSection(node.section))) {
          result.push(node)
        }
      } else if (node.type === 'group') {
        const matchingChildren = filterNodes(node.children || [])
        if (node.label.toLowerCase().includes(q) || matchingChildren.length > 0) {
          autoExpandIds.add(node.id)
          result.push({
            ...node,
            children: matchingChildren.length > 0 ? matchingChildren : node.children
          })
        }
      }
    }
    return result
  }

  return { filteredNodes: filterNodes(nodes), autoExpandIds }
}

