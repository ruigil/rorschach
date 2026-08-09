import { describe, test, expect } from 'bun:test'
import { validateSchema } from '../system/index.ts'

describe('validateSchema', () => {
  test('primitives validation', () => {
    const stringSchema = { type: 'string' }
    expect(validateSchema(stringSchema, 'hello')).toEqual([])
    expect(validateSchema(stringSchema, 123)).toEqual(['Expected type "string" at root, got number'])

    const integerSchema = { type: 'integer' }
    expect(validateSchema(integerSchema, 42)).toEqual([])
    expect(validateSchema(integerSchema, 3.14)).toEqual(['Expected type "integer" at root, got number'])
    expect(validateSchema(integerSchema, '42')).toEqual(['Expected type "integer" at root, got string'])

    const booleanSchema = { type: 'boolean' }
    expect(validateSchema(booleanSchema, true)).toEqual([])
    expect(validateSchema(booleanSchema, 'true')).toEqual(['Expected type "boolean" at root, got string'])

    const nullSchema = { type: 'null' }
    expect(validateSchema(nullSchema, null)).toEqual([])
    expect(validateSchema(nullSchema, undefined)).toEqual([]) // undefined field is skipped unless checked by required
    expect(validateSchema(nullSchema, {})).toEqual(['Expected type "null" at root, got object'])
  })

  test('multiple expected types', () => {
    const nullableStringSchema = { type: ['string', 'null'] }
    expect(validateSchema(nullableStringSchema, 'hello')).toEqual([])
    expect(validateSchema(nullableStringSchema, null)).toEqual([])
    expect(validateSchema(nullableStringSchema, 123)).toEqual(['Expected type ["string","null"] at root, got number'])
  })

  test('enum validation', () => {
    const enumSchema = { type: 'string', enum: ['foo', 'bar'] }
    expect(validateSchema(enumSchema, 'foo')).toEqual([])
    expect(validateSchema(enumSchema, 'baz')).toEqual(['Value at root must be one of: ["foo","bar"]'])
  })

  test('object with properties and required checks', () => {
    const schema = {
      type: 'object',
      required: ['name', 'age'],
      properties: {
        name: { type: 'string' },
        age: { type: 'integer' },
        email: { type: 'string' }
      }
    }

    // Valid
    expect(validateSchema(schema, { name: 'Alice', age: 30 })).toEqual([])

    // Missing required
    expect(validateSchema(schema, { name: 'Alice' })).toEqual([
      'Missing required property "age" at root'
    ])

    // Invalid property type and missing required
    expect(validateSchema(schema, { name: 123 })).toEqual([
      'Missing required property "age" at root',
      'Expected type "string" at name, got number'
    ])
  })

  test('nested objects and path reporting', () => {
    const schema = {
      type: 'object',
      properties: {
        user: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'integer' },
            address: {
              type: 'object',
              properties: {
                city: { type: 'string' }
              }
            }
          }
        }
      }
    }

    const validData = {
      user: {
        id: 1,
        address: {
          city: 'Lisbon'
        }
      }
    }
    expect(validateSchema(schema, validData)).toEqual([])

    const invalidData = {
      user: {
        id: 'one',
        address: {
          city: 123
        }
      }
    }
    expect(validateSchema(schema, invalidData)).toEqual([
      'Expected type "integer" at user.id, got string',
      'Expected type "string" at user.address.city, got number'
    ])
  })

  test('arrays and array items', () => {
    const schema = {
      type: 'array',
      items: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'integer' }
        }
      }
    }

    expect(validateSchema(schema, [{ id: 1 }, { id: 2 }])).toEqual([])

    expect(validateSchema(schema, [{ id: 1 }, { id: 'two' }, {}])).toEqual([
      'Expected type "integer" at root[1].id, got string',
      'Missing required property "id" at root[2]'
    ])
  })
})
