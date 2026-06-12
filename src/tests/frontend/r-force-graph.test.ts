import { describe, test, expect } from 'bun:test'
import { formatKgEdgeLabel, workflowTaskStatusClass } from '../../frontend/components/r-force-graph.js'

describe('r-force-graph', () => {
  test('formats kgraph edge confidence in the visible label', () => {
    expect(formatKgEdgeLabel({ type: 'ABOUT', properties: { confidence: 0.856 } })).toBe('ABOUT c=0.86')
  })

  test('falls back to type when edge confidence is missing or invalid', () => {
    expect(formatKgEdgeLabel({ type: 'PART_OF', properties: {} })).toBe('PART_OF')
    expect(formatKgEdgeLabel({ type: 'DEPENDS_ON', properties: { confidence: '0.8' } })).toBe('DEPENDS_ON')
  })

  test('maps workflow task statuses to stable CSS classes', () => {
    expect(workflowTaskStatusClass('running')).toBe('status-running')
    expect(workflowTaskStatusClass('not_tracked')).toBe('status-not_tracked')
    expect(workflowTaskStatusClass('bad status')).toBe('status-bad-status')
    expect(workflowTaskStatusClass(undefined)).toBe('status-not_tracked')
  })
})
