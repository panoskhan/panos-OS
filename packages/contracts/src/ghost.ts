/**
 * PANOS-OS Ghost Mode wire contract — Phase 7a (interval) + Phase 7b (cron).
 *
 * The shapes and limits the API, the web app and the registry all agree on. Nothing here may import
 * from node:*, because the browser bundles this file: the runtime that owns timers and writes
 * ghosts.jsonl lives in packages/core/src/ghost.ts and re-exports everything below.
 */

/** Fires on a fixed millisecond interval. Minimum MIN_INTERVAL_MS. */
export interface IntervalSchedule {
  type: "interval";
  /** Milliseconds between automatic firings (minimum MIN_INTERVAL_MS) */
  ms: number;
}

/**
 * Phase 7b — fires according to a standard 5-field cron expression.
 * Fields: minute hour day-of-month month day-of-week (Sunday=0).
 * Supports: `*`, integer literals, `*\/n` steps, comma-separated lists.
 * Examples:
 *   "0 9 * * *"    — every day at 09:00
 *   "0 *\/6 * * *" — every 6 hours
 *   "30 8 * * 1"   — 08:30 every Monday
 */
export interface CronSchedule {
  type: "cron";
  /** Standard 5-field cron expression. */
  expression: string;
  /**
   * IANA timezone name for the cron expression, e.g. "Europe/Athens".
   * Defaults to UTC when omitted.
   */
  tz?: string;
}

export type GhostSchedule = IntervalSchedule | CronSchedule;

export type GhostStatus = "active" | "paused" | "deleted";

export interface Ghost {
  id: string;
  goal: string;
  schedule: GhostSchedule;
  /** Actor who registered this ghost (flows through to audit log) */
  actor: string;
  status: GhostStatus;
  createdAt: string;
  /** ISO timestamp of the most recent automatic firing */
  lastFiredAt?: string;
  /** Running count of successful firings */
  fireCount: number;
  /** ISO timestamp of the next scheduled firing (interval and cron). Updated after each fire. */
  nextFireAt?: string;
}

export interface GhostReport {
  ghost: Ghost;
}

/** 5 s — prevents accidental tight loops in production. The registry refuses anything shorter for interval schedules. */
export const MIN_INTERVAL_MS = 5_000;

// ─── Cron helpers (browser-safe, no node:* imports) ──────────────────────────

type CronField = number[];

function parseField(field: string, min: number, max: number): CronField {
  if (field === "*") {
    const out: number[] = [];
    for (let i = min; i <= max; i++) out.push(i);
    return out;
  }
  // */n
  const stepMatch = field.match(/^\*\/(\d+)$/);
  if (stepMatch) {
    const step = parseInt(stepMatch[1], 10);
    const out: number[] = [];
    for (let i = min; i <= max; i += step) out.push(i);
    return out;
  }
  // comma list / single values / ranges like 1-5
  const out = new Set<number>();
  for (const part of field.split(",")) {
    const rangeMatch = part.match(/^(\d+)-(\d+)$/);
    if (rangeMatch) {
      const lo = parseInt(rangeMatch[1], 10);
      const hi = parseInt(rangeMatch[2], 10);
      for (let i = lo; i <= hi; i++) if (i >= min && i <= max) out.add(i);
    } else {
      const v = parseInt(part, 10);
      if (!isNaN(v) && v >= min && v <= max) out.add(v);
    }
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * Parse a 5-field cron expression into numeric value sets.
 * Throws a descriptive string if the expression is invalid.
 */
export function parseCron(expression: string): { mins: CronField; hours: CronField; doms: CronField; months: CronField; dows: CronField } {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`cron_invalid: expected 5 fields, got ${parts.length}`);
  const [minsStr, hoursStr, domsStr, monthsStr, dowsStr] = parts;
  return {
    mins:   parseField(minsStr,   0, 59),
    hours:  parseField(hoursStr,  0, 23),
    doms:   parseField(domsStr,   1, 31),
    months: parseField(monthsStr, 1, 12),
    dows:   parseField(dowsStr,   0,  6),
  };
}

/**
 * Return the next Date on or after `after` that matches the cron expression.
 * Timezone support is best-effort via Intl; falls back to UTC when `tz` is unknown.
 * Searches at most 4 years ahead; returns null if no match found (e.g. Feb 31).
 */
export function nextCronFire(expression: string, after: Date, tz = "UTC"): Date | null {
  const { mins, hours, doms, months, dows } = parseCron(expression);

  // Work in 1-minute steps, starting from the next full minute.
  let cursor = new Date(after.getTime());
  cursor.setSeconds(0, 0);
  cursor.setTime(cursor.getTime() + 60_000); // advance to next minute

  const limit = new Date(after.getTime() + 365 * 4 * 24 * 60 * 60 * 1000);

  while (cursor < limit) {
    // Interpret cursor in the requested timezone via Intl.
    let minute: number, hour: number, dom: number, month: number, dow: number;
    try {
      const fmt = new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        minute: "numeric",
        hour: "numeric",
        day: "numeric",
        month: "numeric",
        weekday: "short",
        hour12: false
      });
      const parts = fmt.formatToParts(cursor);
      const get = (type: string) => parseInt(parts.find((p) => p.type === type)?.value ?? "0", 10);
      minute = get("minute");
      hour = get("hour") % 24;
      dom = get("day");
      month = get("month");
      const dayStr = parts.find((p) => p.type === "weekday")?.value ?? "Sun";
      dow = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(dayStr);
      if (dow === -1) dow = 0;
    } catch {
      // Fallback to UTC
      minute = cursor.getUTCMinutes();
      hour   = cursor.getUTCHours();
      dom    = cursor.getUTCDate();
      month  = cursor.getUTCMonth() + 1;
      dow    = cursor.getUTCDay();
    }

    if (
      months.includes(month) &&
      doms.includes(dom) &&
      dows.includes(dow) &&
      hours.includes(hour) &&
      mins.includes(minute)
    ) {
      return cursor;
    }

    cursor.setTime(cursor.getTime() + 60_000);
  }

  return null;
}
