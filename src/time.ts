const ZURICH = 'Europe/Zurich'

type Civil = { year: number; month: number; day: number; hour: number; minute: number }

const DATETIME_LOCAL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

export type ZurichSlot = { date: string; hour: string; minute: string }

function zurichCandidates(year: number, month: number, day: number, hour: number, minute: number): number[] {
  const wanted: Civil = { year, month, day, hour, minute }
  return [
    Date.UTC(year, month - 1, day, hour - 2, minute, 0),
    Date.UTC(year, month - 1, day, hour - 1, minute, 0)
  ].filter((candidate, index, all) =>
    sameCivil(zurichCivil(candidate), wanted) && all.indexOf(candidate) === index
  )
}

export function nextSlotZurich(nowMs: number): ZurichSlot {
  const target = nowMs + 10 * 60_000
  const civil = zurichCivil(target)
  let candidate = new Date(Date.UTC(civil.year, civil.month - 1, civil.day, civil.hour, Math.ceil(civil.minute / 5) * 5))
  while (true) {
    const date = `${candidate.getUTCFullYear()}-${pad2(candidate.getUTCMonth() + 1)}-${pad2(candidate.getUTCDate())}`
    const hour = pad2(candidate.getUTCHours())
    const minute = pad2(candidate.getUTCMinutes())
    const epochs = zurichCandidates(candidate.getUTCFullYear(), candidate.getUTCMonth() + 1, candidate.getUTCDate(), candidate.getUTCHours(), candidate.getUTCMinutes())
    const epoch = epochs.find((value) => value >= target)
    if (epoch !== undefined && epoch >= target) return { date, hour, minute }
    candidate = new Date(candidate.getTime() + 5 * 60_000)
  }
}

function civilKey(value: Civil): string {
  return `${value.year}-${pad2(value.month)}-${pad2(value.day)}T${pad2(value.hour)}:${pad2(value.minute)}`
}

function zurichCivil(epochMs: number): Civil {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: ZURICH,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(new Date(epochMs))
  const num = (type: Intl.DateTimeFormatPartTypes): number => {
    const found = parts.find((part) => part.type === type)
    return found ? Number(found.value) : Number.NaN
  }
  return {
    year: num('year'),
    month: num('month'),
    day: num('day'),
    hour: num('hour'),
    minute: num('minute')
  }
}

function sameCivil(left: Civil, right: Civil): boolean {
  return civilKey(left) === civilKey(right)
}

/**
 * Zurich is only ever UTC+1 or UTC+2. Trying both offsets avoids a search
 * whose failure branch would be untestable for real clock times. Returns
 * null when the civil time does not exist (the spring-forward gap).
 */
export function zonedZurichToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number
): number | null {
  return zurichCandidates(year, month, day, hour, minute)[0] ?? null
}

/**
 * Reads a `datetime-local` value as Europe/Zurich wall time, not as the
 * server's zone and not as UTC. Seconds are optional and are added after
 * the minute is resolved.
 */
export function parseZurichDateTime(value: string): number | null {
  const match = DATETIME_LOCAL.exec(value)
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const hour = Number(match[4])
  const minute = Number(match[5])
  const second = Number(match[6] ?? '0')
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  if (hour > 23 || minute > 59 || second > 59) return null
  const candidates = zurichCandidates(year, month, day, hour, minute)
  const ms = candidates[0]
  if (ms === undefined) return null
  return ms + second * 1000
}

export function formatZurich(epochMs: number): string {
  const formatted = new Intl.DateTimeFormat('en-GB', {
    timeZone: ZURICH,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).format(new Date(epochMs))
  return `${formatted} Europe/Zurich`
}
