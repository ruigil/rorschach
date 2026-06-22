import { describe, test, expect } from 'bun:test'
import { escHtml, tsStr, modeLabel, toolActionLabel } from '../../frontend/webkit/utils.js'

describe('escHtml', () => {
  test('escapes ampersand', () => {
    expect(escHtml('a&b')).toBe('a&amp;b')
  })

  test('escapes less-than', () => {
    expect(escHtml('a<b')).toBe('a&lt;b')
  })

  test('escapes greater-than', () => {
    expect(escHtml('a>b')).toBe('a&gt;b')
  })

  test('escapes combined characters', () => {
    expect(escHtml('<script>alert("xss")</script>')).toBe('&lt;script&gt;alert("xss")&lt;/script&gt;')
  })

  test('converts number to string', () => {
    expect(escHtml(42)).toBe('42')
  })

  test('handles empty string', () => {
    expect(escHtml('')).toBe('')
  })
})

describe('tsStr', () => {
  test('returns HH:MM:SS.mmm format from timestamp', () => {
    const result = tsStr(0) // Unix epoch
    expect(result).toMatch(/^\d{2}:\d{2}:\d{2}\.\d{3}$/)
  })

  test('returns consistent format for Date input', () => {
    const d = new Date('2025-01-15T10:30:45.123Z')
    const result = tsStr(d)
    expect(result).toBe('10:30:45.123')
  })

  test('returns consistent format for ISO string input', () => {
    const result = tsStr('2025-06-01T14:00:00.000Z')
    expect(result).toBe('14:00:00.000')
  })
})

describe('modeLabel', () => {
  test('returns displayName if provided', () => {
    expect(modeLabel('chatbot', 'Custom Name')).toBe('Custom Name')
  })

  test('capitalizes mode name', () => {
    expect(modeLabel('chatbot')).toBe('Chatbot')
  })

  test('returns "Mode" for empty string', () => {
    expect(modeLabel('')).toBe('Mode')
  })

  test('returns "Mode" when no arguments', () => {
    expect(modeLabel('')).toBe('Mode')
  })
})

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
