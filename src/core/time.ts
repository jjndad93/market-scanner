/** US market time helpers. All market times are New York (Eastern) time. */

export const DAY_MS = 86_400_000;
const NY = 'America/New_York';

const offsetFormat = new Intl.DateTimeFormat('en-US', { timeZone: NY, timeZoneName: 'longOffset' });
const partsFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: NY,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** New York's offset from UTC in minutes at the given instant (-240 during EDT, -300 during EST). */
export function nyOffsetMinutes(at: Date): number {
  const name = offsetFormat.formatToParts(at).find((p) => p.type === 'timeZoneName')?.value ?? 'GMT';
  const m = /GMT([+-])(\d{2}):(\d{2})/.exec(name);
  if (!m) return 0;
  const minutes = Number(m[2]) * 60 + Number(m[3]);
  return m[1] === '-' ? -minutes : minutes;
}

/** Converts a New York wall-clock time on an ISO date (YYYY-MM-DD) to a UTC instant. */
export function nyWallTimeToUtc(isoDate: string, hour: number, minute: number): Date {
  const [y, mo, d] = isoDate.split('-').map(Number);
  const asIfUtc = Date.UTC(y!, mo! - 1, d!, hour, minute);
  let utc = asIfUtc - nyOffsetMinutes(new Date(asIfUtc)) * 60_000;
  // Re-check once in case the guess landed on the other side of a DST change.
  utc = asIfUtc - nyOffsetMinutes(new Date(utc)) * 60_000;
  return new Date(utc);
}

/** Standard US equity options stop trading at 4:00 PM ET on the expiration date. */
export function expirationCloseUtc(isoDate: string): Date {
  return nyWallTimeToUtc(isoDate, 16, 0);
}

/** Year fraction on an actual/365 calendar-day basis. */
export function yearsBetween(from: Date, to: Date): number {
  return (to.getTime() - from.getTime()) / (365 * DAY_MS);
}

function nyParts(at: Date): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of partsFormat.formatToParts(at)) out[p.type] = p.value;
  return out;
}

export function nyDateString(at: Date): string {
  const p = nyParts(at);
  return `${p.year}-${p.month}-${p.day}`;
}

export function formatNy(at: Date): string {
  const p = nyParts(at);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute} ET`;
}

export function daysBetweenIsoDates(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

export function addDaysIso(isoDate: string, days: number): string {
  return new Date(Date.parse(`${isoDate}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

function isoIfValid(y: number, m: number, d: number): string | null {
  const t = new Date(Date.UTC(y, m - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return null;
  return t.toISOString().slice(0, 10);
}

/**
 * Reads a calendar date in the common formats brokers display:
 * 2026-12-18, 12/18/2026, 12/18/26, Dec 18 2026, December 18, 2026, 18 Dec 2026.
 * Returns YYYY-MM-DD, or null if the text is not a real date.
 */
export function parseDateLoose(text: string): string | null {
  const s = text.trim().replace(/(\d)(st|nd|rd|th)\b/gi, '$1').replace(/,/g, ' ').replace(/\s+/g, ' ');
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (m) return isoIfValid(Number(m[1]), Number(m[2]), Number(m[3]));
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(s);
  if (m) {
    const y = m[3]!.length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    return isoIfValid(y, Number(m[1]), Number(m[2]));
  }
  m = /^([a-z]{3})[a-z]*\.? (\d{1,2}) (\d{4})$/i.exec(s);
  if (m) {
    const month = MONTHS[m[1]!.toLowerCase()];
    return month ? isoIfValid(Number(m[3]), month, Number(m[2])) : null;
  }
  m = /^(\d{1,2}) ([a-z]{3})[a-z]*\.? (\d{4})$/i.exec(s);
  if (m) {
    const month = MONTHS[m[2]!.toLowerCase()];
    return month ? isoIfValid(Number(m[3]), month, Number(m[1])) : null;
  }
  return null;
}

/**
 * Reads a quote timestamp. "2026-10-20 09:45 ET" (or with no zone, assumed ET) is treated
 * as New York time; full ISO strings with Z or an offset are used as-is.
 */
export function parseQuoteTime(text: string): { iso: string; assumedEt: boolean } | null {
  const s = text.trim();
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{1,2}):(\d{2})(?::\d{2})?\s*(am|pm)?\s*(et|est|edt)?$/i.exec(s);
  if (m) {
    if (!isoIfValid(...(m[1]!.split('-').map(Number) as [number, number, number]))) return null;
    let hour = Number(m[2]);
    const ampm = m[4]?.toLowerCase();
    if (ampm === 'pm' && hour < 12) hour += 12;
    if (ampm === 'am' && hour === 12) hour = 0;
    if (hour > 23 || Number(m[3]) > 59) return null;
    return { iso: nyWallTimeToUtc(m[1]!, hour, Number(m[3])).toISOString(), assumedEt: !m[5] };
  }
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(s)) {
    const t = Date.parse(s);
    return Number.isNaN(t) ? null : { iso: new Date(t).toISOString(), assumedEt: false };
  }
  return null;
}
