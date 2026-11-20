import { expect, it } from 'vitest'
import { lookupDates } from '../lookupDates'

it('uses local date boundaries across month and year changes', () => {
  const now = new Date(2026, 0, 1, 14, 30)
  expect(lookupDates(now, 'timestamp', false).map(({ value }) => value)).toEqual([
    '2026-01-01 00:00:00',
    '2025-12-31 00:00:00',
    '2026-01-01 00:00:00',
    '2025-12-01 00:00:00',
    '2026-01-01 00:00:00'
  ])
  expect(lookupDates(now, 'date', false)[0].value).toBe('2026-01-01')
  expect(lookupDates(now, 'timestamp', true)[0].value).toBe('2026-01-01T00:00:00')
})
