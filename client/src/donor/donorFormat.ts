// Donor-screen formatting and the one date rule the client is allowed to do
// itself: showing when a cooldown ends. Eligibility is still decided by the
// server (server-authoritative) — this is display arithmetic, not a gate.
const MS_PER_DAY = 86_400_000;

/** PROTOCOL.md § parameters: DONATION_COOLDOWN_DAYS = 56 (US whole blood). */
export const DONATION_COOLDOWN_DAYS = 56;

export const SNOOZE_24H_MS = 24 * 60 * 60 * 1000;
export const SNOOZE_7D_MS = 7 * MS_PER_DAY;

export function eligibleAgainAt(lastDonationAt: string): Date {
  return new Date(new Date(lastDonationAt).getTime() + DONATION_COOLDOWN_DAYS * MS_PER_DAY);
}

/** Locale date, e.g. "Sep 24, 2026". Falls back to the raw value if unparseable. */
export function formatDay(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return typeof value === 'string' ? value : '';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(date);
}

/** Locale date + time, for snooze windows that end mid-day. */
export function formatDayTime(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return typeof value === 'string' ? value : '';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
    date,
  );
}

export function isFuture(value: string, now: Date = new Date()): boolean {
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.getTime() > now.getTime();
}

export type SnoozeChoice = '24h' | '7d';

/**
 * Which snooze quick-row reads as active. The server stores an instant, not the
 * button that produced it, so the remaining time decides: anything still more
 * than a day out came from the 7-day row.
 */
export function activeSnooze(snoozeUntil: string | null, now: Date = new Date()): SnoozeChoice | null {
  if (snoozeUntil === null) return null;
  const until = new Date(snoozeUntil).getTime();
  if (Number.isNaN(until) || until <= now.getTime()) return null;
  return until - now.getTime() > SNOOZE_24H_MS ? '7d' : '24h';
}
