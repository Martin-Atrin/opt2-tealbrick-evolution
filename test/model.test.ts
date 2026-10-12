// Pure workflow rules: step ids, allowlist normalisation, CRUD defaults, promotion checks, version diffs.
import assert from "node:assert/strict";
import { test } from "node:test";
import { checkPromotable, diffSnapshots, guessCrud, ModelError, normalizeAllowed, normalizeSteps, type Snapshot } from "../src/model.ts";

test("steps get stable ids; duplicate ids are refused", () => {
  assert.deepEqual(normalizeSteps([{ title: " A " }, { id: "s1", title: "B" }, { title: "C" }]).map((s) => [s.id, s.title]), [
    ["s2", "A"],
    ["s1", "B"],
    ["s3", "C"],
  ]);
  assert.throws(() => normalizeSteps([{ id: "x", title: "A" }, { id: "x", title: "B" }]), ModelError);
});

test("allowed operations: one entry per product, sorted, CRUD in canonical order", () => {
  assert.deepEqual(
    normalizeAllowed([
      { product: "kanban", operations: ["issues_list"], crud: ["read"] },
      { product: "connect", operations: ["channel_inbox"], crud: ["read"] },
      { product: "kanban", operations: ["issue_create", "issues_list"], crud: ["create"] },
    ]),
    [
      { product: "connect", operations: ["channel_inbox"], crud: ["read"] },
      { product: "kanban", operations: ["issue_create", "issues_list"], crud: ["create", "read"] },
    ],
  );
  assert.deepEqual(guessCrud(["issues_list"]), ["read"]);
  assert.deepEqual(guessCrud(["issue_create", "issue_update", "document_delete"]), ["create", "read", "update", "delete"]);
});

const base: Snapshot = {
  title: "T",
  summary: "",
  instruction: "Do it.",
  trigger: "",
  steps: normalizeSteps([
    { id: "a", title: "A", ops: [{ product: "kanban", operation: "issues_list" }] },
    { id: "b", title: "B" },
  ]),
  allowed: normalizeAllowed([{ product: "kanban", operations: ["issues_list"], crud: ["read"] }]),
};

test("promotion needs an instruction, an allowlist, and every step op inside it", () => {
  checkPromotable(base);
  assert.throws(() => checkPromotable({ ...base, instruction: " " }), /instruction/);
  assert.throws(() => checkPromotable({ ...base, allowed: [] }), /at least one operation/);
  assert.throws(() => checkPromotable({ ...base, steps: normalizeSteps([{ title: "X", ops: [{ product: "kanban", operation: "issue_delete" }] }]) }), /not in the allowed/);
});

test("diff: reorder and edits by step id; narrowing access is not widening", () => {
  const [a, b] = base.steps as [Snapshot["steps"][number], Snapshot["steps"][number]];
  const next: Snapshot = {
    ...base,
    steps: [{ ...b, instruction: "now with text" }, a, { id: "c", title: "C", instruction: "", ops: [] }],
    allowed: normalizeAllowed([{ product: "kanban", operations: ["issues_list"], crud: ["read", "update"] }]),
  };
  const d = diffSnapshots(base, next);
  assert.deepEqual(d.steps.added, ["C"]);
  assert.deepEqual(d.steps.changed, [
    { id: "b", title: "B", fields: ["instruction", "order"] },
    { id: "a", title: "A", fields: ["order"] },
  ]);
  assert.equal(d.widensAccess, true, "more CRUD on the same op set widens access");
  assert.equal(diffSnapshots(next, base).widensAccess, false);
  assert.deepEqual(diffSnapshots(base, base), { fields: [], steps: { added: [], removed: [], changed: [] }, operations: { added: [], removed: [] }, widensAccess: false });
});
