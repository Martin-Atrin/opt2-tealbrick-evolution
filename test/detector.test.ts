// Kanban evidence → suggestion: the pattern detector over a fake companion call (the real call path, grant and
// bridge envelope, is the SDK's `callApp`; conformance A12 covers it for apps whose agent ops call companions).
import assert from "node:assert/strict";
import { test } from "node:test";
import type { CompanionResult } from "@opt2-tealbrick/miniapp-sdk";
import { TbError } from "@opt2-tealbrick/miniapp-sdk";
import type * as K from "#kit";
import { handlers } from "../src/app.ts";
import { buildGroups, normalizeTitle, parseDoneIssues } from "../src/detector.ts";
import { AGENT_A, AGENT_B, type CallApp, call, ctxFor, migratedDb, OWNER } from "./helpers.ts";

const H = handlers as unknown as Parameters<typeof call>[0];

const issue = (id: string, title: string, agent: string, extra: Record<string, unknown> = {}) => ({
  id,
  title,
  status: "done",
  assignee: { type: "agent", id: agent },
  updatedAt: `2026-10-0${id.slice(-1)}T10:00:00Z`,
  ...extra,
});

function kanban(issues: unknown[], calls: { product: string; op: string; input: unknown }[] = []): CallApp {
  return async (product, op, input) => {
    calls.push({ product, op, input });
    return { status: "ok", output: { issues } } as unknown as CompanionResult;
  };
}

test("normalised titles ignore numbers, case and punctuation", () => {
  assert.equal(normalizeTitle("Weekly report #41 — Team"), normalizeTitle("weekly REPORT 42 team"));
  assert.notEqual(normalizeTitle("Weekly report"), normalizeTitle("Monthly report"));
});

test("the parser keeps done issues assigned to an agent, in any of the accepted shapes", () => {
  const out = parseDoneIssues({
    issues: [
      issue("i1", "A", AGENT_A.id),
      { id: "i2", title: "B", status: "done", assigneeId: AGENT_B.id, templateId: "tpl-x" },
      { id: "i3", title: "C", status: "in_progress", assignee: { type: "agent", id: AGENT_A.id } },
      { id: "i4", title: "D", status: "done", assignee: { type: "owner", id: "per_1" } },
      { id: "i5", status: "done", assignee: AGENT_A.id },
      "junk",
    ],
  });
  assert.deepEqual(out.map((i) => [i.id, i.agentId, i.template]), [
    ["i1", AGENT_A.id, null],
    ["i2", AGENT_B.id, "tpl-x"],
  ]);
  assert.deepEqual(parseDoneIssues({ items: [issue("i1", "A", AGENT_A.id)] }).length, 1);
  assert.deepEqual(parseDoneIssues(null), []);
});

test("groups are per agent and per template (or title); covered issues are skipped", () => {
  const issues = parseDoneIssues({
    issues: [
      issue("i1", "Weekly report 1", AGENT_A.id),
      issue("i2", "Weekly report 2", AGENT_A.id),
      issue("i3", "Weekly report 3", AGENT_B.id),
      issue("i4", "Anything", AGENT_A.id, { template: "weekly" }),
      issue("i5", "Else", AGENT_A.id, { template: { id: "weekly" } }),
    ],
  });
  const groups = buildGroups(issues, new Set(["i2"]));
  const byKey = Object.fromEntries(groups.map((g) => [g.key, g.issues.map((i) => i.id)]));
  assert.deepEqual(byKey, {
    [`${AGENT_A.id}|title:weekly report #`]: ["i1"],
    [`${AGENT_B.id}|title:weekly report #`]: ["i3"],
    [`${AGENT_A.id}|template:weekly`]: ["i5", "i4"],
  });
});

test("Kanban evidence → suggestion: N ≥ 3 by one agent creates one suggestion; a re-scan adds new evidence, never duplicates", async () => {
  const db = migratedDb();
  db.prepare("INSERT INTO agent_names (id, name, seen_at) VALUES (?, ?, ?)").run(AGENT_A.id, "Agent A", 1);
  const calls: { product: string; op: string; input: unknown }[] = [];
  const three = [issue("i1", "Weekly report 1", AGENT_A.id), issue("i2", "Weekly report 2", AGENT_A.id), issue("i3", "weekly report 3", AGENT_A.id), issue("i4", "Weekly report 4", AGENT_B.id)];
  const r1 = await call<K.DetectorScanOutput>(H, "detector_scan", {}, ctxFor(db, OWNER, kanban(three, calls)));
  assert.deepEqual(calls[0], { product: "kanban", op: "issues_list", input: { status: "done", limit: 200 } });
  assert.equal(r1.kanban, "ok");
  assert.equal(r1.issuesSeen, 4);
  assert.equal(r1.created.length, 1, "agent B has one issue only: no suggestion");
  assert.equal(r1.created[0]?.agentId, AGENT_A.id);
  assert.equal(r1.created[0]?.evidenceCount, 3);
  const s = await call<K.ReviewSuggestionOutput>(H, "review_suggestion", { id: r1.created[0]?.id }, ctxFor(db, OWNER));
  assert.equal(s.suggestion.source, "detector");
  assert.match(s.suggestion.summary, /Agent A finished 3 Kanban issues/);
  assert.deepEqual(s.suggestion.evidence.map((e) => [e.kind, e.ref, e.title]), [
    ["kanban_issue", "i3", "weekly report 3"],
    ["kanban_issue", "i2", "Weekly report 2"],
    ["kanban_issue", "i1", "Weekly report 1"],
  ]);

  // the agent whose work it is can read it
  const mine = await call<K.SuggestionsListOutput>(H, "suggestions_list", {}, ctxFor(db, AGENT_A));
  assert.equal(mine.suggestions.length, 1);

  const r2 = await call<K.DetectorScanOutput>(H, "detector_scan", {}, ctxFor(db, OWNER, kanban(three)));
  assert.deepEqual([r2.created.length, r2.updated.length], [0, 0], "same issues: nothing new");
  const r3 = await call<K.DetectorScanOutput>(H, "detector_scan", {}, ctxFor(db, OWNER, kanban([...three, issue("i5", "Weekly report 5", AGENT_A.id)])));
  assert.deepEqual([r3.created.length, r3.updated.length, r3.updated[0]?.evidenceCount], [0, 1, 4], "open suggestion gets the new issue");

  // after a decision the group starts over and needs N new issues again
  await call(H, "suggestion_decide", { id: r1.created[0]?.id, decision: "reject" }, ctxFor(db, OWNER));
  const more = [issue("i6", "Weekly report 6", AGENT_A.id), issue("i7", "Weekly report 7", AGENT_A.id)];
  const r4 = await call<K.DetectorScanOutput>(H, "detector_scan", {}, ctxFor(db, OWNER, kanban([...three, ...more])));
  assert.deepEqual([r4.created.length, r4.updated.length], [0, 0]);
  const r5 = await call<K.DetectorScanOutput>(H, "detector_scan", { minRepeats: 2 }, ctxFor(db, OWNER, kanban([...three, ...more])));
  assert.equal(r5.created.length, 1);
});

test("Kanban is a soft dependency: not deployed, refused or held → a normal answer, nothing written", async () => {
  const db = migratedDb();
  const absent: CallApp = async () => {
    throw new TbError("companion_undeclared", "no grant", 403);
  };
  const r = await call<K.DetectorScanOutput>(H, "detector_scan", {}, ctxFor(db, OWNER, absent));
  assert.equal(r.kanban, "unavailable");
  assert.match(r.message ?? "", /companion_undeclared/);
  const held: CallApp = async () => ({ status: "held", holdId: "hld_1", expiresAt: "x" }) as unknown as CompanionResult;
  assert.equal((await call<K.DetectorScanOutput>(H, "detector_scan", {}, ctxFor(db, OWNER, held))).kanban, "unavailable");
  assert.equal((await call<K.ReviewSuggestionsOutput>(H, "review_suggestions", {}, ctxFor(db, OWNER))).suggestions.length, 0);
});
