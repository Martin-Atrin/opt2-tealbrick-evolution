// recipe_export emits a recipe Core accepts on `drafts.import` (PORTAL-API §3) — checked against the spec route table
// and Core's import rules: draftable ops only, `$ref`s to EARLIER steps, no `ws`, no concrete Portal id, inputs that
// match AgentCreateInput / AgentPolicySetInput / EdgeCreateInput (field names and the new-card policy revision 1).
import assert from "node:assert/strict";
import { test } from "node:test";
import { ROUTES } from "@opt2-tealbrick/spec/routes";
import { normalizeAllowed, type Snapshot } from "../src/model.ts";
import { buildRecipe, nonPortable, type Recipe } from "../src/recipe.ts";

const snap: Snapshot = {
  title: "Daily status rollup",
  summary: "",
  instruction: "Write the rollup.",
  trigger: "Every day at 17:00",
  steps: [],
  allowed: normalizeAllowed([
    { product: "kanban", operations: ["issues_list", "issue_create"], crud: ["read", "create"] },
    { product: "knowledge", operations: ["remember"], crud: ["create"] },
  ]),
};
const wf = { id: "wfl_01JABCDEFGHJKMNPQRSTVWXYZ0", version: 3, snapshot: snap };

const REF_RE = /^#\/steps\/(\d+)\/output(\/.*)?$/;
function refs(v: unknown, out: string[] = []): string[] {
  if (v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 1 && typeof (v as { $ref?: unknown }).$ref === "string") out.push((v as { $ref: string }).$ref);
  else if (Array.isArray(v)) for (const x of v) refs(x, out);
  else if (v && typeof v === "object") for (const x of Object.values(v)) refs(x, out);
  return out;
}

test("a recipe Core can import: format, draftable ops, backward refs, portable", () => {
  const r: Recipe = buildRecipe(wf);
  assert.equal(r.format, "tealbrick.recipe/1");
  assert.ok(r.title.length <= 120 && (r.description ?? "").length <= 2000);
  const rows = new Map(ROUTES.map((x) => [x.opId as string, x]));
  r.steps.forEach((s, n) => {
    const row = rows.get(s.opId);
    assert.ok(row?.draftable, `${s.opId} is draftable`);
    for (const ref of refs(s.input)) {
      const m = REF_RE.exec(ref);
      assert.ok(m && Number(m[1]) < n, `step ${n}: ${ref} points to an earlier step`);
    }
  });
  assert.deepEqual(nonPortable(r), []);
  assert.ok(JSON.stringify(r).includes(wf.id), "the purpose names the workflow (inside text, not as a bare id)");
});

test("steps: create the card, set it Bound with the allowlist, one edge per product (incl. Evolution workflow_get and the routine ops)", () => {
  const r = buildRecipe(wf, { agentName: "Rollup bot", harnessOptionId: "claude-desktop" });
  const [create, policy, ...edges] = r.steps;
  assert.equal(create?.opId, "agents.create");
  assert.deepEqual(Object.keys(create?.input ?? {}).sort(), ["harnessOptionId", "name", "purpose"]);
  assert.equal(create?.input.name, "Rollup bot");
  assert.equal(create?.input.harnessOptionId, "claude-desktop");
  assert.ok(String(create?.input.purpose).length <= 500);

  assert.equal(policy?.opId, "agents.policy_set");
  assert.deepEqual(policy?.input.agt, { $ref: "#/steps/0/output/id" });
  assert.equal(policy?.input.revision, 1, "a new card's policy revision");
  assert.equal(policy?.input.mode, "bound");
  assert.ok(((policy?.input.held ?? []) as string[]).includes("money"), "money must be held (policy_invalid otherwise)");
  assert.deepEqual(policy?.input.workflow, [
    { product: "evolution", operations: ["routine_claim", "routine_report", "routines_due", "workflow_get"] },
    { product: "kanban", operations: ["issue_comment_add", "issue_create", "issue_get", "issues_list"] },
    { product: "knowledge", operations: ["remember"] },
  ]);
  assert.deepEqual(
    edges.map((e) => [e.opId, e.input.product, e.input.crud]),
    [
      ["edges.create", "evolution", ["read", "update"]],
      ["edges.create", "kanban", ["create", "read"]],
      ["edges.create", "knowledge", ["create"]],
    ],
  );
  for (const e of edges) assert.deepEqual(Object.keys(e.input).sort(), ["agt", "crud", "product"]);
});

test("defaults and limits: harness generic-mcp, long names clipped to 64", () => {
  const r = buildRecipe({ ...wf, snapshot: { ...snap, title: "x".repeat(300) } });
  assert.equal(r.steps[0]?.input.harnessOptionId, "generic-mcp");
  assert.equal(String(r.steps[0]?.input.name).length, 64);
});

test("every Bound agent may read and comment on its Kanban run issues, even when the workflow itself does not use Kanban", () => {
  const r = buildRecipe({ ...wf, snapshot: { ...snap, allowed: normalizeAllowed([{ product: "knowledge", operations: ["remember"], crud: ["create"] }]) } });
  const policy = r.steps[1]?.input.workflow as { product: string; operations: string[] }[];
  assert.deepEqual(policy.find((p) => p.product === "kanban"), { product: "kanban", operations: ["issue_comment_add", "issue_get"] });
  assert.ok(r.steps.some((s) => s.opId === "edges.create" && s.input.product === "kanban"));
  assert.match(r.description ?? "", /share with the agent/);
});
