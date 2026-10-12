// Cron (5 fields, UTC): `minute hour day-of-month month day-of-week`, with `*`, lists, ranges and steps.
// ONE cron mechanism (STEP-B-DESIGN §3.1, Coordinator answer): @opt2-tealbrick/manifest 0.1.7 exports
// `nextCronTime(cron, after)`. Until Evolution depends on 0.1.7 this file carries an interim implementation with the
// same contract; when the package exports the helper, `nextCronTime` below delegates to it and the local parser only
// validates input. Remove the local code when the dependency is 0.1.7 or later.
import * as manifestPkg from "@opt2-tealbrick/manifest";

type CronFn = (cron: string, after: number | Date) => number | Date;
const shared = (manifestPkg as unknown as { nextCronTime?: CronFn }).nextCronTime;

export class CronError extends Error {}

interface Spec {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  domAny: boolean;
  dowAny: boolean;
}

const RANGES: [number, number][] = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
];
const NAMES = ["minute", "hour", "day of month", "month", "day of week"];

function field(text: string, i: number): { set: Set<number>; any: boolean } {
  const [lo, hi] = RANGES[i] as [number, number];
  const set = new Set<number>();
  for (const part of text.split(",")) {
    const m = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part);
    if (!m) throw new CronError(`Cron ${NAMES[i]}: "${part}" is not a number, range, list or step.`);
    const step = m[4] ? Number(m[4]) : 1;
    const from = m[1] === "*" ? lo : Number(m[2]);
    const to = m[1] === "*" ? hi : m[3] ? Number(m[3]) : m[4] ? hi : from;
    if (step < 1 || from < lo || to > hi || from > to) throw new CronError(`Cron ${NAMES[i]}: "${part}" is outside ${lo}-${hi}.`);
    for (let v = from; v <= to; v += step) set.add(i === 4 && v === 7 ? 0 : v);
  }
  return { set, any: text === "*" || text === "*/1" };
}

export function parseCron(cron: string): Spec {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) throw new CronError("A schedule needs 5 cron fields: minute hour day-of-month month day-of-week (UTC).");
  const f = parts.map((p, i) => field(p, i));
  const [mi, h, dm, mo, dw] = f as [ReturnType<typeof field>, ReturnType<typeof field>, ReturnType<typeof field>, ReturnType<typeof field>, ReturnType<typeof field>];
  return { minute: mi.set, hour: h.set, dom: dm.set, month: mo.set, dow: dw.set, domAny: dm.any, dowAny: dw.any };
}

function dayMatches(s: Spec, d: Date): boolean {
  const dom = s.dom.has(d.getUTCDate());
  const dow = s.dow.has(d.getUTCDay());
  // classic cron: when both day fields are restricted, either one matches
  if (!s.domAny && !s.dowAny) return dom || dow;
  return dom && dow;
}

function localNext(s: Spec, after: number): number {
  const d = new Date(Math.floor(after / 60_000) * 60_000 + 60_000);
  const limit = after + 5 * 366 * 86_400_000;
  while (d.getTime() <= limit) {
    if (!s.month.has(d.getUTCMonth() + 1)) {
      d.setUTCMonth(d.getUTCMonth() + 1, 1);
      d.setUTCHours(0, 0, 0, 0);
      continue;
    }
    if (!dayMatches(s, d)) {
      d.setUTCDate(d.getUTCDate() + 1);
      d.setUTCHours(0, 0, 0, 0);
      continue;
    }
    if (!s.hour.has(d.getUTCHours())) {
      d.setUTCHours(d.getUTCHours() + 1, 0, 0, 0);
      continue;
    }
    if (!s.minute.has(d.getUTCMinutes())) {
      d.setUTCMinutes(d.getUTCMinutes() + 1, 0, 0);
      continue;
    }
    return d.getTime();
  }
  throw new CronError("This schedule never fires.");
}

/** First fire time strictly after `after` (ms epoch, UTC). Throws CronError on an invalid or never-firing cron. */
export function nextCronTime(cron: string, after: number): number {
  const spec = parseCron(cron);
  if (shared) {
    const v = shared(cron, after);
    return typeof v === "number" ? v : v.getTime();
  }
  return localNext(spec, after);
}

/** The latest fire time ≤ `now`, scanning forward from `from` (a fire time); null when `from` is after `now`.
 *  Bounded: at most `max` steps, then the scan restarts close to `now` (a long-offline runner collapses to one run). */
export function latestFireAtOrBefore(cron: string, from: number, now: number, max = 1000): number | null {
  if (from > now) return null;
  let t = from;
  for (let i = 0; i < max; i++) {
    const n = nextCronTime(cron, t);
    if (n > now) return t;
    t = n;
  }
  // very frequent cron over a long gap: look back one day from now and scan again
  return latestFireAtOrBefore(cron, Math.max(t, nextCronTime(cron, now - 86_400_000)), now, max * 2);
}
