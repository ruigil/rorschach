import { describe, expect, test } from 'bun:test'
import { getUserTimeContext, isValidTimezone } from '../system/index.ts'

describe('Timezone validation & getUserTimeContext utility', () => {
  test('isValidTimezone validates correctly', () => {
    expect(isValidTimezone('America/New_York')).toBe(true)
    expect(isValidTimezone('Europe/Paris')).toBe(true)
    expect(isValidTimezone('UTC')).toBe(true)
    expect(isValidTimezone('Invalid/Timezone')).toBe(false)
    expect(isValidTimezone('')).toBe(false)
  })

  test('getUserTimeContext formats standard timezones', () => {
    // 2026-07-24T15:15:17Z
    const testDate = new Date('2026-07-24T15:15:17Z')

    // UTC
    const utcContext = getUserTimeContext('UTC', testDate)
    expect(utcContext.timezone).toBe('UTC')
    expect(utcContext.dayOfWeek).toBe('Friday')
    expect(utcContext.offset).toBe('+00:00')
    expect(utcContext.iso).toContain('2026-07-24T15:15:17+00:00')

    // New York (GMT-4 in July DST)
    const nyContext = getUserTimeContext('America/New_York', testDate)
    expect(nyContext.timezone).toBe('America/New_York')
    expect(nyContext.dayOfWeek).toBe('Friday')
    expect(nyContext.offset).toBe('-04:00')
    expect(nyContext.iso).toContain('2026-07-24T11:15:17-04:00')

    // Tokyo (GMT+9)
    const tokyoContext = getUserTimeContext('Asia/Tokyo', testDate)
    expect(tokyoContext.timezone).toBe('Asia/Tokyo')
    expect(tokyoContext.dayOfWeek).toBe('Saturday') // It's Saturday July 25 at 00:15 in Tokyo
    expect(tokyoContext.offset).toBe('+09:00')
    expect(tokyoContext.iso).toContain('2026-07-25T00:15:17+09:00')
  })

  test('getUserTimeContext handles fallback for invalid timezone', () => {
    const testDate = new Date('2026-07-24T15:15:17Z')
    const fallbackContext = getUserTimeContext('Invalid/Timezone_Name', testDate)
    expect(fallbackContext.timezone).toBeDefined()
    expect(fallbackContext.iso).toBeDefined()
  })
})
