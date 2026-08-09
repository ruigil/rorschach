/**
 * A self-contained validator for JSON Schema drafts commonly used in tool definitions.
 * Validates basic types, nested objects, required fields, enums, and arrays recursively,
 * returning a list of detailed validation errors.
 */
export const validateSchema = (schema: any, data: any, path: string = ''): string[] => {
  const errors: string[] = []
  if (schema === undefined || schema === null) return errors

  // Boolean schemas (true matches anything, false matches nothing)
  if (typeof schema === 'boolean') {
    if (!schema) {
      errors.push(`Value at ${path || 'root'} is not allowed (schema is false)`)
    }
    return errors
  }

  // Handle case where data is undefined (unless required checking handles it at the parent level,
  // we check type match if type is specified)
  if (data === undefined) {
    return errors
  }

  // Type validation
  const expectedType = schema.type
  if (expectedType) {
    const actualType = getJsonType(data)
    const expectedTypes = Array.isArray(expectedType) ? expectedType : [expectedType]
    
    let typeMatched = false
    for (const t of expectedTypes) {
      if (t === 'integer') {
        if (actualType === 'number' && Number.isInteger(data)) {
          typeMatched = true
          break
        }
      } else if (actualType === t) {
        typeMatched = true
        break
      }
    }
    
    if (!typeMatched) {
      errors.push(`Expected type ${JSON.stringify(expectedType)} at ${path || 'root'}, got ${actualType}`)
    }
  }

  // Enum validation
  if (Array.isArray(schema.enum)) {
    let match = false
    for (const val of schema.enum) {
      if (deepEquals(data, val)) {
        match = true
        break
      }
    }
    if (!match) {
      errors.push(`Value at ${path || 'root'} must be one of: ${JSON.stringify(schema.enum)}`)
    }
  }

  // Object validation
  if (schema.type === 'object' || (!schema.type && schema.properties)) {
    if (typeof data !== 'object' || data === null || Array.isArray(data)) {
      errors.push(`Expected object at ${path || 'root'}, got ${getJsonType(data)}`)
      return errors
    }

    // Required properties validation
    if (Array.isArray(schema.required)) {
      for (const req of schema.required) {
        if (data[req] === undefined) {
          errors.push(`Missing required property "${req}" at ${path || 'root'}`)
        }
      }
    }

    // Properties validation
    if (schema.properties && typeof schema.properties === 'object') {
      for (const [key, propSchema] of Object.entries(schema.properties)) {
        errors.push(...validateSchema(propSchema, data[key], path ? `${path}.${key}` : key))
      }
    }
  }

  // Array validation
  if (schema.type === 'array') {
    if (!Array.isArray(data)) {
      errors.push(`Expected array at ${path || 'root'}, got ${getJsonType(data)}`)
      return errors
    }

    if (schema.items) {
      data.forEach((item, idx) => {
        errors.push(...validateSchema(schema.items, item, `${path || 'root'}[${idx}]`))
      })
    }
  }

  return errors
}

const getJsonType = (val: any): string => {
  if (val === null) return 'null'
  if (Array.isArray(val)) return 'array'
  const t = typeof val
  if (t === 'number') return 'number'
  if (t === 'string') return 'string'
  if (t === 'boolean') return 'boolean'
  if (t === 'object') return 'object'
  return t
}

const deepEquals = (a: any, b: any): boolean => {
  if (a === b) return true
  if (typeof a !== typeof b) return false
  if (a && b && typeof a === 'object') {
    if (Array.isArray(a) !== Array.isArray(b)) return false
    if (Array.isArray(a)) {
      if (a.length !== b.length) return false
      for (let i = 0; i < a.length; i++) {
        if (!deepEquals(a[i], b[i])) return false
      }
      return true
    }
    const keysA = Object.keys(a)
    const keysB = Object.keys(b)
    if (keysA.length !== keysB.length) return false
    for (const key of keysA) {
      if (!keysB.includes(key)) return false
      if (!deepEquals(a[key], b[key])) return false
    }
    return true
  }
  return false
}
