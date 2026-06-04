import { describe, test, expect } from 'bun:test'
import { formatKgEdgeLabel } from '../../frontend/components/r-force-graph.js'

describe('r-force-graph', () => {
  test('formats kgraph edge confidence in the visible label', () => {
    expect(formatKgEdgeLabel({ type: 'ABOUT', properties: { confidence: 0.856 } })).toBe('ABOUT c=0.86')
  })

  test('falls back to type when edge confidence is missing or invalid', () => {
    expect(formatKgEdgeLabel({ type: 'PART_OF', properties: {} })).toBe('PART_OF')
    expect(formatKgEdgeLabel({ type: 'DEPENDS_ON', properties: { confidence: '0.8' } })).toBe('DEPENDS_ON')
  })
})
