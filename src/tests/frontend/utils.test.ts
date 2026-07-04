import { describe, test, expect } from 'bun:test'
import { toolActionLabel } from '../../frontend/webkit/utils.js'


describe('toolActionLabel', () => {
  test('returns "working..." for empty array', () => {
    expect(toolActionLabel([])).toBe('working...')
  })

  test('returns searching label for web_search', () => {
    expect(toolActionLabel(['web_search'])).toBe('searching the web...')
  })

  test('returns analysing label for analyze_image', () => {
    expect(toolActionLabel(['analyze_image'])).toBe('analysing image...')
  })

  test('returns running label for other single tool', () => {
    expect(toolActionLabel(['fetch_page'])).toBe('running fetch_page...')
  })

  test('returns count label for multiple tools', () => {
    expect(toolActionLabel(['web_search', 'fetch_page'])).toBe('invoking 2 tools...')
  })

  test('returns count label for three tools', () => {
    expect(toolActionLabel(['a', 'b', 'c'])).toBe('invoking 3 tools...')
  })
})
