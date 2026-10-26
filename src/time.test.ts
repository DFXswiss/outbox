import { describe, expect, it } from 'vitest'
import { nextSlotZurich, parseZurichDateTime } from './time'

describe('nextSlotZurich', () => {
  it('chooses a 5-minute slot at least ten minutes ahead and rolls the date', () => {
    const now = Date.UTC(2024, 0, 1, 22, 54)
    expect(nextSlotZurich(now)).toEqual({ date: '2024-01-02', hour: '00', minute: '05' })
  })

  it('skips the missing hour when Zurich starts daylight saving time', () => {
    const now = Date.UTC(2024, 2, 31, 0, 50)
    expect(nextSlotZurich(now)).toEqual({ date: '2024-03-31', hour: '03', minute: '00' })
  })

  it('uses the new offset when Zurich ends daylight saving time', () => {
    const now = Date.UTC(2024, 9, 27, 0, 50)
    const slot = nextSlotZurich(now)
    expect(slot).toEqual({ date: '2024-10-27', hour: '02', minute: '00' })
    expect(parseZurichDateTime(`${slot.date}T${slot.hour}:${slot.minute}`)).toBe(Date.UTC(2024, 9, 27, 0, 0))
  })
})
