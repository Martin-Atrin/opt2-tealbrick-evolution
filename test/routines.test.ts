// Step B: schedules, due/claim/report at-most-once, misfire, collapse, sweep, pause, policy_stale, Kanban run issues.
// STEP-B-DESIGN §2.3 rows R1–R7 have runner-side twins in the CLI (bridge c83-routines); these are the server side.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Caller, CompanionResult, Db } from "@opt2-tealbrick/miniapp-sdk";
import type * as K from "#kit";
import { handlers } from "../src/app.ts";
import { buildGroups, parseDoneIssues } from "../src/detector.ts";
import * as r from "../src/routines.ts";
import * as store from "../src/store.ts";
import { AGENT_A, type CallApp, call, ctxFor, migratedDb, OWNER } from "./helpers.ts";

const H = handlers as unknown as Parameters<typeof call>[0];
const BOUND: Caller = { ...AGENT_A, mode: "bound" };
const OTHER: Caller = { type: "agent", id: "agt_01J0000000000000000000000C" as Caller["id"], name: "C", mode: "bound" };
const T = (s: string) => Date.parse(s);
const D0 = T("2026-10-12T06:00:00Z");

function workflow(db: Db, allowed = [{ product: "kanban", operations: ["issues_list"], crud: ["read" as const] }]): string {
  const d = store.createDraft(db, { suggestionId: null, templateId: null, snapshot: { title: "Morning rollup", summary: "", instruction: "Roll up.", trigger: "08:00", steps: [], allowed } }, D0);
  return store.promote(db, d.id, d.revision, D0).workflow.id;
}
function widen(db: Db, workflowId: string): void {
  const wf = store.getWorkflow(db, workflowId);
  const d = store.getDraft(db, wf.draftId);
  const u = store.updateDraft(db, d.id, d.revision, { allowed: [...d.allowed, { product: "knowledge", operations: ["remember"], crud: ["create"] }] }, D0);
  store.promote(db, d.id, u.revision, D0);
}
function daily(db: Db, extra: Partial<r.AutomationInput> = {}): r.Automation {
  return r.setAutomation(db, { workflowId: workflow(db), agentId: BOUND.id, cron: "0 8 * * *", ...extra }, D0);
}

test("R1/R2: one due job → one claim; any second claim of that occurrence is refused; reports move forward only", () => {
  const db = migratedDb();
  const a = daily(db);
  assert.equal(a.nextDueAt, "2026-10-12T08:00:00.000Z");
  assert.deepEqual(r.dueJobs(db, BOUND.id, T("2026-10-12T07:59:59Z")), [], "not due yet");
  const now = T("2026-10-12T08:00:30Z");
  const jobs = r.dueJobs(db, BOUND.id, now);
  assert.equal(jobs.length, 1);
  const occ = jobs[0]?.occurrence as string;
  assert.equal(occ, r.occurrenceOf(a.id, a.revision, T("2026-10-12T08:00:00Z")));
  assert.deepEqual(r.dueJobs(db, OTHER.id, now), [], "only the scheduled agent sees it");

  const c = r.claim(db, BOUND, occ, now);
  assert.equal(c.claimed, true);
  if (c.claimed) {
    assert.equal(c.job.instruction, "Roll up.");
    assert.equal(c.job.version, 1);
    assert.deepEqual(c.job.allowed, [{ product: "kanban", operations: ["issues_list"], crud: ["read"] }]);
  }
  assert.deepEqual(r.claim(db, BOUND, occ, now + 1000), { claimed: false, reason: "already_claimed" });
  assert.deepEqual(r.claim(db, OTHER, occ, now + 1000), { claimed: false, reason: "already_claimed" });
  assert.deepEqual(r.dueJobs(db, BOUND.id, now + 1000), [], "a claimed occurrence is never offered again");

  assert.throws(() => r.report(db, OTHER.id, occ, "completed", null, now), /No run of yours/);
  assert.equal(r.report(db, BOUND.id, occ, "dispatched", null, now).run.status, "dispatched");
  assert.equal(r.report(db, BOUND.id, occ, "completed", "done", now).run.status, "completed");
  assert.equal(r.report(db, BOUND.id, occ, "completed", "again", now).changed, false, "repeat = no-op");
  assert.throws(() => r.report(db, BOUND.id, occ, "failed", null, now), (e: unknown) => e instanceof store.StoreError && e.code === "conflict");
  assert.equal(r.dueJobs(db, BOUND.id, T("2026-10-13T08:00:10Z")).length, 1, "the next day is due again");
});

test("only Bound agents claim; a non-matching occurrence is not_due", () => {
  const db = migratedDb();
  daily(db);
  const now = T("2026-10-12T08:00:30Z");
  const occ = r.dueJobs(db, BOUND.id, now)[0]?.occurrence as string;
  assert.deepEqual(r.claim(db, { ...BOUND, mode: "free" }, occ, now), { claimed: false, reason: "not_bound" });
  assert.deepEqual(r.claim(db, BOUND, "0".repeat(64), now), { claimed: false, reason: "not_due" });
  assert.deepEqual(r.claim(db, OTHER, occ, now), { claimed: false, reason: "not_due" }, "another agent's occurrence does not leak");
});

test("R6: misfire grace — late polls get no job, missed periods collapse into ONE missed record and ONE next run", () => {
  const db = migratedDb();
  const a = daily(db);
  const late = T("2026-10-12T08:02:01Z"); // grace 120 s
  assert.deepEqual(r.dueJobs(db, BOUND.id, late), []);
  const missedOcc = r.occurrenceOf(a.id, a.revision, T("2026-10-12T08:00:00Z"));
  assert.deepEqual(r.claim(db, BOUND, missedOcc, late), { claimed: false, reason: "missed" });
  assert.equal(r.listRuns(db, { limit: 10 }, late)[0]?.status, "missed");

  // offline for three days, back one minute after the fire time: one job (today), earlier days are one missed record
  const back = T("2026-10-16T08:01:00Z");
  const jobs = r.dueJobs(db, BOUND.id, back);
  assert.deepEqual(jobs.map((j) => j.dueAt), ["2026-10-16T08:00:00.000Z"]);
  assert.equal(r.claim(db, BOUND, jobs[0]?.occurrence as string, back).claimed, true);
  const runs = r.listRuns(db, { automationId: a.id, limit: 10 }, back);
  assert.deepEqual(runs.map((x) => [x.dueAt.slice(0, 10), x.status]), [
    ["2026-10-16", "claimed"],
    ["2026-10-13", "missed"],
    ["2026-10-12", "missed"],
  ]);
});

test("R3/R4: no report in time → uncertain, never re-offered; a late report still closes it", () => {
  const db = migratedDb();
  daily(db);
  const now = T("2026-10-12T08:00:30Z");
  const occ = r.dueJobs(db, BOUND.id, now)[0]?.occurrence as string;
  r.claim(db, BOUND, occ, now);
  assert.equal(r.listRuns(db, { limit: 5 }, now + 11 * 60_000)[0]?.status, "uncertain", "owner view derives it before a sweep");
  assert.equal(r.sweep(db, now + 11 * 60_000), 1);
  assert.deepEqual(r.dueJobs(db, BOUND.id, now + 11 * 60_000), []);
  assert.equal(r.report(db, BOUND.id, occ, "completed", "late", now + 12 * 60_000).run.status, "completed");

  // dispatched runs get 30 min
  const db2 = migratedDb();
  daily(db2);
  const occ2 = r.dueJobs(db2, BOUND.id, now)[0]?.occurrence as string;
  r.claim(db2, BOUND, occ2, now);
  r.report(db2, BOUND.id, occ2, "dispatched", null, now + 60_000);
  assert.equal(r.sweep(db2, now + 20 * 60_000), 0);
  assert.equal(r.sweep(db2, now + 32 * 60_000), 1);
});

test("pause, resume, edit and delete: a changed schedule never reuses an old occurrence", () => {
  const db = migratedDb();
  const a = daily(db);
  const now = T("2026-10-12T08:00:30Z");
  const occ = r.dueJobs(db, BOUND.id, now)[0]?.occurrence as string;
  const paused = r.pauseAutomation(db, a.id, a.revision, true, now);
  assert.equal(paused.enabled, false);
  assert.deepEqual(r.dueJobs(db, BOUND.id, now), []);
  assert.equal(r.claim(db, BOUND, occ, now).claimed, false);
  const resumed = r.pauseAutomation(db, a.id, paused.revision, false, now);
  assert.equal(resumed.nextDueAt, "2026-10-13T08:00:00.000Z", "resume starts from now");
  assert.throws(() => r.pauseAutomation(db, a.id, paused.revision, true, now), (e: unknown) => e instanceof store.StoreError && e.code === "revision_conflict");
  assert.throws(() => r.setAutomation(db, { id: a.id, revision: resumed.revision, workflowId: a.workflowId, agentId: BOUND.id, cron: "61 * * * *" }, now), /minute/);
  r.deleteAutomation(db, a.id, resumed.revision, now);
  assert.deepEqual(r.listAutomations(db, now), []);
  assert.deepEqual(r.dueJobs(db, BOUND.id, T("2026-10-13T08:00:10Z")), []);
});

test("policy_stale: following the active version, a wider version needs the new recipe applied first", () => {
  const db = migratedDb();
  const a = daily(db);
  widen(db, a.workflowId);
  const now = T("2026-10-12T08:00:30Z");
  const occ = r.dueJobs(db, BOUND.id, now)[0]?.occurrence as string;
  assert.deepEqual(r.claim(db, BOUND, occ, now), { claimed: false, reason: "policy_stale" });
  // the owner applies v2's recipe and says so
  const cur = r.listAutomations(db, now)[0] as r.Automation;
  const b = r.setAutomation(db, { id: a.id, revision: cur.revision, workflowId: a.workflowId, agentId: BOUND.id, cron: cur.cron, policyVersion: 2 }, now);
  const job = r.dueJobs(db, BOUND.id, T("2026-10-13T08:00:10Z"))[0];
  assert.equal(job?.version, 2);
  assert.equal(r.claim(db, BOUND, job?.occurrence as string, T("2026-10-13T08:00:10Z")).claimed, true);
  // a pinned version keeps running the pinned text
  const pinned = r.setAutomation(db, { id: a.id, revision: b.revision, workflowId: a.workflowId, agentId: BOUND.id, cron: cur.cron, versionPin: 1, policyVersion: 1 }, now);
  assert.equal(r.dueJobs(db, BOUND.id, T("2026-10-14T08:00:10Z"))[0]?.version, 1);
  assert.equal(pinned.versionPin, 1);
});

// ── through the handlers, with a fake Kanban companion ──

function kanban(fail = false) {
  const calls: { op: string; input: Record<string, unknown>; key: string | undefined }[] = [];
  const callApp: CallApp = async (_product, op, input, opts) => {
    calls.push({ op, input: input as Record<string, unknown>, key: (opts as { idempotencyKey?: string } | undefined)?.idempotencyKey });
    if (fail) throw new Error("kanban down");
    return { status: "ok", output: op === "issue_create" ? { id: "iss_run1", title: "x" } : { id: "iss_run1" } } as unknown as CompanionResult;
  };
  return { calls, callApp };
}

test("every claimed run is a Kanban issue assigned to the Bound agent (template = workflow run key), closed on report", async () => {
  const db = migratedDb();
  const owner = ctxFor(db, OWNER);
  const wf = workflow(db);
  const viaOp = await call<K.AutomationSetOutput>(H, "automation_set", { workflowId: wf, agentId: BOUND.id, cron: "0 8 * * *" }, owner);
  assert.equal(viaOp.workflowTitle, "Morning rollup");
  assert.equal(viaOp.policyVersion, 1);
  await call(H, "automation_delete", { id: viaOp.id, revision: viaOp.revision }, owner);
  // created a minute ago, so one occurrence is due now (handlers use the real clock)
  const set = r.setAutomation(db, { workflowId: wf, agentId: BOUND.id, cron: "* * * * *" }, Date.now() - 60_000);
  await assert.rejects(call(H, "automation_set", { workflowId: wf, agentId: BOUND.id, cron: "* * *" }, owner), /5 cron fields/);
  await assert.rejects(call(H, "automation_set", { workflowId: "wfl_missing", agentId: BOUND.id, cron: "* * * * *" }, owner), /No workflow/);

  const k = kanban();
  const free = await call<K.RoutinesDueOutput>(H, "routines_due", {}, ctxFor(db, { ...BOUND, mode: "free" }));
  assert.deepEqual(free.jobs, [], "a Free agent has no runs");
  const due = await call<K.RoutinesDueOutput>(H, "routines_due", {}, ctxFor(db, BOUND, k.callApp));
  assert.equal(due.jobs.length, 1);
  const occ = due.jobs[0]?.occurrence as string;
  const c = await call<K.RoutineClaimOutput>(H, "routine_claim", { occurrence: occ }, ctxFor(db, BOUND, k.callApp));
  assert.equal(c.claimed, true);
  assert.equal(c.job?.kanbanIssueId, "iss_run1");
  assert.equal(c.job?.kanbanTemplate, r.runTemplateKey(wf));
  assert.match(r.runTemplateKey(wf), /^[a-z0-9][a-z0-9._:-]*$/, "Kanban template key pattern");
  assert.equal(k.calls[0]?.op, "issue_create");
  assert.deepEqual(
    { assignee: k.calls[0]?.input.assignee, template: k.calls[0]?.input.template, status: k.calls[0]?.input.status, project: k.calls[0]?.input.project },
    { assignee: BOUND.id, template: r.runTemplateKey(wf), status: "in_progress", project: undefined },
  );
  assert.equal(k.calls[0]?.key, `evolution-run:${occ}`, "a repeated create never makes a second issue");

  const again = await call<K.RoutineClaimOutput>(H, "routine_claim", { occurrence: occ }, ctxFor(db, BOUND, k.callApp));
  assert.deepEqual([again.claimed, again.reason], [false, "already_claimed"]);
  assert.equal(k.calls.length, 1, "no issue for a refused claim");

  await call(H, "routine_report", { occurrence: occ, status: "dispatched" }, ctxFor(db, BOUND, k.callApp));
  assert.equal(k.calls.length, 1);
  const done = await call<K.RoutineReportOutput>(H, "routine_report", { occurrence: occ, status: "completed", summary: "Rollup written." }, ctxFor(db, BOUND, k.callApp));
  assert.deepEqual([done.status, done.kanbanIssueId, done.kanbanSync], ["completed", "iss_run1", "done"]);
  assert.deepEqual(k.calls[1], { op: "issue_complete", input: { issue: "iss_run1", result: "Rollup written." }, key: `evolution-close:${occ}:completed` });

  const runs = await call<K.RunsListOutput>(H, "runs_list", { automationId: set.id }, owner);
  assert.equal(runs.runs[0]?.status, "completed");
  const list = await call<K.AutomationsListOutput>(H, "automations_list", {}, owner);
  assert.equal(list.automations.length, 1);
});

test("Kanban is optional for runs: a failing companion never fails the claim or the report; failed runs block the issue", async () => {
  const db = migratedDb();
  const wf = workflow(db);
  r.setAutomation(db, { workflowId: wf, agentId: BOUND.id, cron: "* * * * *" }, Date.now() - 60_000);
  const down = kanban(true);
  const occ = (await call<K.RoutinesDueOutput>(H, "routines_due", {}, ctxFor(db, BOUND))).jobs[0]?.occurrence as string;
  const c = await call<K.RoutineClaimOutput>(H, "routine_claim", { occurrence: occ }, ctxFor(db, BOUND, down.callApp));
  assert.deepEqual([c.claimed, c.job?.kanbanIssueId], [true, null]);
  const rep = await call<K.RoutineReportOutput>(H, "routine_report", { occurrence: occ, status: "failed", summary: "x" }, ctxFor(db, BOUND, down.callApp));
  assert.deepEqual([rep.status, rep.kanbanSync], ["failed", "failed"]);

  // with an issue: failed → issue_block
  const db2 = migratedDb();
  const wf2 = workflow(db2);
  r.setAutomation(db2, { workflowId: wf2, agentId: BOUND.id, cron: "* * * * *", kanbanProject: "prj_runs" }, Date.now() - 60_000);
  const up = kanban();
  const occ2 = (await call<K.RoutinesDueOutput>(H, "routines_due", {}, ctxFor(db2, BOUND))).jobs[0]?.occurrence as string;
  await call(H, "routine_claim", { occurrence: occ2 }, ctxFor(db2, BOUND, up.callApp));
  assert.equal(up.calls[0]?.input.project, "prj_runs");
  await call(H, "routine_report", { occurrence: occ2, status: "failed", summary: "Kanban write refused" }, ctxFor(db2, BOUND, up.callApp));
  assert.deepEqual(up.calls[1], { op: "issue_block", input: { issue: "iss_run1", reason: "Run failed: Kanban write refused" }, key: `evolution-close:${occ2}:failed` });
});

test("the detector never suggests runs of an Evolution workflow", () => {
  const issues = parseDoneIssues({
    issues: [1, 2, 3].map((n) => ({ id: `i${n}`, title: `Run: Morning rollup ${n}`, status: "done", assignee: { kind: "agent", id: BOUND.id, name: "A" }, template: r.runTemplateKey("wfl_01JX") })),
  });
  assert.deepEqual(issues, []);
  assert.deepEqual(buildGroups(issues, new Set()), []);
});
