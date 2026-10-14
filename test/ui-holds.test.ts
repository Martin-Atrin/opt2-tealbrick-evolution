// RUL-01: Approve / Deny on the Holds page show errors instead of dropping them.
import assert from "node:assert/strict";
import { test } from "node:test";
import { decideOrError } from "../src/ui/ops.ts";

test("RUL-01 fires: a failed decision (expired hold, 409, network) becomes the message shown", async () => {
  const expired = async () => {
    throw new Error("This hold expired. Ask the agent to call again.");
  };
  assert.equal(await decideOrError(expired, "hld_1", "approve"), "This hold expired. Ask the agent to call again.");
  const odd = async () => {
    throw "not an Error";
  };
  assert.equal(await decideOrError(odd, "hld_1", "deny"), "Something went wrong.");
});

test("RUL-01 quiet: a decision that goes through shows no error", async () => {
  const seen: [string, string][] = [];
  const ok = async (id: never, decision: "approve" | "deny") => {
    seen.push([id, decision]);
  };
  assert.equal(await decideOrError(ok, "hld_2", "approve"), null);
  assert.deepEqual(seen, [["hld_2", "approve"]]);
});
