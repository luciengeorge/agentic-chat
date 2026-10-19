// 👨‍💼 Grace's digest runs on `0 9 * * 1`. A scheduler that wakes up needs one answer from this file: which of the
//    schedule's times came due since it last looked, and which was the latest.
//
// 🦉 Already written in this file: `parseCron` (five fields into sets of numbers) and `nextAfter` (the first slot
//    strictly after a time, skipping months, days and hours that can't match). You write `latestSlot`.

/**
 * Cron expressions (section 16.4), the five-field kind: minute, hour, day of the month, month, day of the week.
 * Each field takes `*`, a number, a range `a-b`, a step `*\/n` or `a-b/n`, and lists of those. Days of the week
 * run 0 to 6 from Sunday (7 is Sunday too). All times are UTC.
 *
 * As in classic cron, when both day fields are restricted, a day matches if either does.
 */

export class CronError extends Error {
  override name = "CronError";
}

export interface Cron {
  source: string;
  minutes: ReadonlySet<number>;
  hours: ReadonlySet<number>;
  days: ReadonlySet<number>;
  months: ReadonlySet<number>;
  weekdays: ReadonlySet<number>;
  daysRestricted: boolean;
  weekdaysRestricted: boolean;
}

const FIELDS = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day of the month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  { name: "day of the week", min: 0, max: 7 },
] as const;

function parseField(text: string, { name, min, max }: (typeof FIELDS)[number]): Set<number> {
  const values = new Set<number>();
  for (const part of text.split(",")) {
    const match = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part);
    if (!match) throw new CronError(`"${part}" isn't a valid ${name}`);
    const [, range, stepText] = match;
    const step = stepText === undefined ? 1 : Number(stepText);
    const bounds: number[] = range === "*" ? [min, max] : range.split("-").map(Number);
    const from = bounds[0];
    const to = bounds[1] ?? (stepText === undefined ? from : max);
    if (from < min || to > max || from > to || step < 1) {
      throw new CronError(`"${part}" is outside ${min} to ${max} for the ${name}`);
    }
    for (let v = from; v <= to; v += step) values.add(v);
  }
  return values;
}

export function parseCron(expression: string): Cron {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) throw new CronError("a schedule needs five fields: minute hour day month weekday");
  const [minutes, hours, days, months, weekdays] = parts.map((part, i) => parseField(part, FIELDS[i]));
  if (weekdays.delete(7)) weekdays.add(0);
  const cron: Cron = {
    source: parts.join(" "),
    minutes,
    hours,
    days,
    months,
    weekdays,
    daysRestricted: parts[2] !== "*",
    weekdaysRestricted: parts[4] !== "*",
  };
  nextAfter(cron, new Date(Date.UTC(2026, 0, 1)));
  return cron;
}

function dayMatches(cron: Cron, t: Date): boolean {
  const day = cron.days.has(t.getUTCDate());
  const weekday = cron.weekdays.has(t.getUTCDay());
  if (cron.daysRestricted && cron.weekdaysRestricted) return day || weekday;
  return day && weekday;
}

const MINUTE = 60_000;
const SEARCH_STEPS = 50_000;

/** The first time the schedule fires strictly after `after`, to the minute. */
export function nextAfter(cron: Cron, after: Date): Date {
  const t = new Date(Math.floor(after.getTime() / MINUTE) * MINUTE + MINUTE);
  for (let i = 0; i < SEARCH_STEPS; i++) {
    if (!cron.months.has(t.getUTCMonth() + 1)) {
      t.setUTCMonth(t.getUTCMonth() + 1, 1);
      t.setUTCHours(0, 0, 0, 0);
    } else if (!dayMatches(cron, t)) {
      t.setUTCDate(t.getUTCDate() + 1);
      t.setUTCHours(0, 0, 0, 0);
    } else if (!cron.hours.has(t.getUTCHours())) {
      t.setUTCHours(t.getUTCHours() + 1, 0, 0, 0);
    } else if (!cron.minutes.has(t.getUTCMinutes())) {
      t.setTime(t.getTime() + MINUTE);
    } else {
      return t;
    }
  }
  throw new CronError(`"${cron.source}" never fires`);
}

/** The latest time the schedule fired in (`after`, `upTo`], or null if it didn't. */
export function latestSlot(cron: Cron, after: Date, upTo: Date): Date | null {
  // 🐨 Return the schedule's latest slot in the window `(after, upTo]`, or null when none falls in it.
  // 🐨 The window is half-open: a slot exactly at `after` is out, a slot exactly at `upTo` is in.
  //
  // 💰 `nextAfter(cron, t)` gives the first slot strictly after `t`. Dates compare with `<` and `<=`.
  //
  // 🦉 Why half-open. `dueSlot` (in `automation.ts`) passes the last fire as `after` and the tick's time as `upTo`.
  //    A slot at `after` was fired already: counting it would fire 09:00 again on every tick after it. A slot at
  //    `upTo` is due now. Windows laid end to end, (09:00, 09:30] then (09:30, 10:00], hold every slot once.
  //
  // 🚨 The tests check both ends of the window, the latest of several slots, and a window with none.
  throw new Error(
    `latestSlot(${cron.source}, after ${after.toISOString()}, up to ${upTo.toISOString()}) isn't written yet`,
  );
}
