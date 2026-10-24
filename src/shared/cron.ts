/**
 * Minimal 5-field cron (min hour dom month dow) helpers for /v1/schedules.
 * Supports *, N, N-M, star/N, N-M/N, and comma lists. Dow: 0-7 (0 and 7 = Sunday).
 * Timezone is an IANA name resolved via Intl (e.g. "UTC", "America/New_York").
 */

export type CronField = { values: Set<number> };

const RANGES = { minute: [0, 59], hour: [0, 23], day: [1, 31], month: [1, 12], dow: [0, 7] } as const;

function parseField(raw: string, min: number, max: number, name: string): Set<number> {
  const out = new Set<number>();
  for (const part of raw.split(",")) {
    const m = part.trim().match(/^(?:\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/);
    if (!m) throw new Error(`invalid cron ${name} field ${JSON.stringify(part)}`);
    const start = m[1] === undefined ? min : Number(m[1]);
    const end = m[2] === undefined ? (m[1] === undefined ? max : start) : Number(m[2]);
    const step = m[3] === undefined ? 1 : Number(m[3]);
    if (![start, end, step].every((n) => Number.isInteger(n)) || step < 1 || start < min || end > max || start > end) {
      throw new Error(`invalid cron ${name} field ${JSON.stringify(part)}`);
    }
    for (let n = start; n <= end; n += step) out.add(n);
  }
  if (name === "dow" && out.has(7)) { out.add(0); out.delete(7); }
  return out;
}

export interface CronExpr {
  minute: Set<number>;
  hour: Set<number>;
  day: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  raw: string;
}

/** Parse a standard 5-field cron expression; throws on malformed input. */
export function parseCron(expr: string): CronExpr {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`cron must have 5 fields (min hour dom month dow), got ${parts.length}`);
  return {
    raw: expr.trim(),
    minute: parseField(parts[0]!, ...RANGES.minute, "minute"),
    hour: parseField(parts[1]!, ...RANGES.hour, "hour"),
    day: parseField(parts[2]!, ...RANGES.day, "day"),
    month: parseField(parts[3]!, ...RANGES.month, "month"),
    dow: parseField(parts[4]!, ...RANGES.dow, "dow"),
  };
}

/** Reject unknown IANA timezones early (Intl throws RangeError). */
export function assertTimezone(tz: string): string {
  if (!tz || typeof tz !== "string") throw new Error("timezone is required");
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz }).format(new Date());
  } catch {
    throw new Error(`unknown timezone ${JSON.stringify(tz)}`);
  }
  return tz;
}

interface ZonedParts { year: number; month: number; day: number; hour: number; minute: number; dow: number }

function zonedParts(date: Date, timeZone: string): ZonedParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)?.value;
  const wd = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[get("weekday")!];
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour: Number(get("hour")),
    minute: Number(get("minute")),
    dow: wd ?? 0,
  };
}

function matches(expr: CronExpr, p: ZonedParts): boolean {
  if (!expr.minute.has(p.minute) || !expr.hour.has(p.hour) || !expr.month.has(p.month)) return false;
  const dayOk = expr.day.has(p.day);
  const dowOk = expr.dow.has(p.dow);
  // Classic cron: when both day-of-month and day-of-week are restricted (not `*`), match either.
  const dayStar = expr.day.size === 31;
  const dowStar = expr.dow.size === 7;
  if (dayStar && dowStar) return true;
  if (dayStar) return dowOk;
  if (dowStar) return dayOk;
  return dayOk || dowOk;
}

/**
 * Next fire time strictly after `after` in the given timezone.
 * Searches minute-by-minute up to ~2 years ahead; returns null if none found.
 */
export function nextRunAfter(expr: CronExpr | string, after: Date, timeZone: string): Date | null {
  const cron = typeof expr === "string" ? parseCron(expr) : expr;
  assertTimezone(timeZone);
  // Start at the next whole minute after `after`.
  const start = new Date(after.getTime());
  start.setUTCSeconds(0, 0);
  if (start.getTime() <= after.getTime()) start.setUTCMinutes(start.getUTCMinutes() + 1);

  const limit = start.getTime() + 366 * 2 * 24 * 60 * 60 * 1000;
  // Walk in UTC minutes; evaluate wall-clock parts in the schedule timezone.
  for (let t = start.getTime(); t < limit; t += 60_000) {
    const d = new Date(t);
    if (matches(cron, zonedParts(d, timeZone))) return d;
  }
  return null;
}

/** True when `at` (to the minute) matches the expression in `timeZone`. */
export function cronMatchesAt(expr: CronExpr | string, at: Date, timeZone: string): boolean {
  const cron = typeof expr === "string" ? parseCron(expr) : expr;
  return matches(cron, zonedParts(at, timeZone));
}
