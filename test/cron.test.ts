// Interim cron helper (same contract as @opt2-tealbrick/manifest 0.1.7 nextCronTime): 5 fields, UTC.
import assert from "node:assert/strict";
import { test } from "node:test";
import { CronError, latestFireAtOrBefore, nextCronTime } from "../src/cron.ts";

const t = (s: string) => Date.parse(s);
const at = (cron: string, after: string) => new Date(nextCronTime(cron, t(after))).toISOString();

test("next fire time is strictly after, minute resolution, UTC", () => {
  assert.equal(at("0 8 * * 1", "2026-10-12T07:00:00Z"), "2026-10-12T08:00:00.000Z", "Monday 08:00");
  assert.equal(at("0 8 * * 1", "2026-10-12T08:00:00Z"), "2026-10-19T08:00:00.000Z", "strictly after");
  assert.equal(at("*/15 * * * *", "2026-10-12T08:07:30Z"), "2026-10-12T08:15:00.000Z");
  assert.equal(at("0 9-17/4 * * *", "2026-10-12T13:00:00Z"), "2026-10-12T17:00:00.000Z");
  assert.equal(at("30 2 1 * *", "2026-10-12T00:00:00Z"), "2026-11-01T02:30:00.000Z");
  assert.equal(at("0 0 * * 7", "2026-10-12T00:00:00Z"), "2026-10-18T00:00:00.000Z", "7 = Sunday");
  assert.equal(at("0 0 29 2 *", "2026-10-12T00:00:00Z"), "2028-02-29T00:00:00.000Z", "leap day");
  // both day fields restricted: either matches (classic cron)
  assert.equal(at("0 0 13 * 5", "2026-10-12T00:00:00Z"), "2026-10-13T00:00:00.000Z");
  assert.equal(at("0 0 1,15 * *", "2026-10-12T00:00:00Z"), "2026-10-15T00:00:00.000Z");
});

test("invalid schedules are refused with a reason", () => {
  for (const bad of ["* * * *", "60 * * * *", "* 24 * * *", "* * 0 * *", "* * * 13 *", "a * * * *", "5-1 * * * *", "*/0 * * * *", "0 0 31 2 *"])
    assert.throws(() => nextCronTime(bad, 0), CronError, bad);
});

test("latest fire time at or before now (collapsing missed periods)", () => {
  const from = t("2026-10-10T08:00:00Z");
  assert.equal(new Date(latestFireAtOrBefore("0 8 * * *", from, t("2026-10-12T08:00:30Z")) ?? 0).toISOString(), "2026-10-12T08:00:00.000Z");
  assert.equal(latestFireAtOrBefore("0 8 * * *", from, t("2026-10-10T07:59:00Z")), null);
  assert.equal(new Date(latestFireAtOrBefore("* * * * *", t("2026-01-01T00:00:00Z"), t("2026-10-12T08:00:30Z")) ?? 0).toISOString(), "2026-10-12T08:00:00.000Z", "frequent cron over a long gap");
});
