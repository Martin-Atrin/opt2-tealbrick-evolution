// Bound-agent recipe (PORTAL-API §3, `tealbrick.recipe/1`): the zero-spine-change path for G7. The owner imports it in
// Portal (`tealbrick recipe import` or the GUI) and applies it in the browser with ONE confirmation:
//   0 agents.create      a new card (Core always creates it Free)
//   1 agents.policy_set  mode bound, workflow = the allowed operations per product (grant `wf`), held + caps
//   2… edges.create      one agent→app edge per product, CRUD = the access the workflow needs
// Every id is a `$ref` to step 0's output; `ws` is absent (import fills it). Core refuses any other concrete id.
// EVO-01 (L1): the held families and harness ids come from the shared packages, never retyped here.
import { DEFAULT_HELD_FAMILIES } from "@opt2-tealbrick/manifest";
import { HARNESS_OPTION_IDS, type HarnessOptionId, type Recipe as SpecRecipe } from "@opt2-tealbrick/spec/routes";
import type { Allowed, Crud, Snapshot } from "./model.ts";
import { ModelError, normalizeAllowed } from "./model.ts";

export const RECIPE_FORMAT: SpecRecipe["format"] = "tealbrick.recipe/1";
/** Evolution itself: a Bound agent reads its workflow and claims/reports its scheduled runs. */
export const SELF_OPS: Allowed = { product: "evolution", operations: ["routine_claim", "routine_report", "routines_due", "workflow_get"], crud: ["read", "update"] };
/** A new card's policy revision in Core (agent_policies.revision starts at 1). */
export const NEW_POLICY_REVISION = 1;
/** The held families of a new card (spec DEFAULT_HELD_FAMILIES, C105/C107): a recipe never holds less than a new agent. */
export const DEFAULT_HELD = DEFAULT_HELD_FAMILIES;
/**
 * Core's new-card caps (portal-core registries/agents.ts DEFAULT_CAPS). Not in the spec yet: REQUESTS SPEC-1 asks for
 * one shared constant; replace this copy with the import when it ships.
 */
export const DEFAULT_CAPS = { write: { max: 500, per: "hour" }, outward: { max: 30, per: "hour" }, destructive: { max: 20, per: "day" } } as const;
export const DEFAULT_HARNESS: HarnessOptionId = "generic-mcp";

export interface RecipeStep {
  opId: "agents.create" | "agents.policy_set" | "edges.create";
  input: Record<string, unknown>;
}
/** The spec's exported recipe (PORTAL-API §3) with Evolution's three step kinds. */
export interface Recipe extends Omit<SpecRecipe, "steps"> {
  steps: RecipeStep[];
}
// compile-time check: an Evolution recipe is a spec Recipe
const _isSpecRecipe = (r: Recipe): SpecRecipe => r;
void _isSpecRecipe;

/** A harness option id the spec knows (HARNESS_OPTION_IDS); anything else is refused before Core sees it. */
export function harnessOption(id: string | undefined): HarnessOptionId {
  if (id === undefined) return DEFAULT_HARNESS;
  if (!(HARNESS_OPTION_IDS as readonly string[]).includes(id)) throw new ModelError(`Unknown harness "${id}". Use one of: ${HARNESS_OPTION_IDS.join(", ")}.`, "/harnessOptionId");
  return id as HarnessOptionId;
}

const AGENT_REF = { $ref: "#/steps/0/output/id" } as const;

function clip(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

/** Kanban: every scheduled run is an issue assigned to the Bound agent; it reads it and comments on it there. */
export const RUN_ISSUE_OPS: Allowed = { product: "kanban", operations: ["issue_comment_add", "issue_get"], crud: ["read", "create"] };

export function boundAllowed(allowed: readonly Allowed[]): Allowed[] {
  return normalizeAllowed([...allowed, SELF_OPS, RUN_ISSUE_OPS]);
}

export function buildRecipe(
  wf: { id: string; version: number; snapshot: Snapshot },
  opts: { agentName?: string; harnessOptionId?: string } = {},
): Recipe {
  const allowed = boundAllowed(wf.snapshot.allowed);
  const name = clip(opts.agentName?.trim() || `${wf.snapshot.title} (Bound)`, 64);
  const purpose = clip(
    `Bound agent for the Evolution workflow "${wf.snapshot.title}" v${wf.version}. Runs come from tealbrick agent serve (routines mode); before each run it reads evolution__workflow_get {"id":"${wf.id}"}. It may call only the allowed operations.`,
    500,
  );
  const steps: RecipeStep[] = [
    { opId: "agents.create", input: { name, purpose, harnessOptionId: harnessOption(opts.harnessOptionId) } },
    {
      opId: "agents.policy_set",
      input: {
        agt: AGENT_REF,
        revision: NEW_POLICY_REVISION,
        mode: "bound",
        held: [...DEFAULT_HELD],
        caps: structuredClone(DEFAULT_CAPS) as unknown as Record<string, unknown>,
        workflow: allowed.map((a) => ({ product: a.product, operations: a.operations })),
      },
    },
    ...allowed.map((a): RecipeStep => ({ opId: "edges.create", input: { agt: AGENT_REF, product: a.product, crud: [...a.crud] as Crud[] } })),
  ];
  const ops = allowed.map((a) => `${a.product}: ${a.operations.join(", ")}`).join("; ");
  return {
    format: RECIPE_FORMAT,
    title: clip(`Bound agent: ${wf.snapshot.title} v${wf.version}`, 120),
    description: clip(
      `Creates one agent, sets it Bound and connects it to ${allowed.length} app(s). The agent may call only: ${ops}. The bridge blocks every other operation; it does not force the agent to follow the workflow steps. Trigger: ${wf.snapshot.trigger || "none set"}. Schedule it on Evolution's Schedules page after you apply this recipe; every run is a Kanban issue assigned to this agent in the project you choose there, so choose a Kanban project you share with the agent (it may read and comment on its run issues).`,
      2000,
    ),
    steps,
  };
}

/** Portability rule Core applies on import (`recipe_not_portable`): no concrete Portal id anywhere. */
export const PORTAL_ID = /^[a-z]{2,3}_[0-9A-HJKMNP-TV-Z]{26}$/;
export function nonPortable(recipe: Recipe): string[] {
  const bad: string[] = [];
  const walk = (v: unknown, path: string): void => {
    if (typeof v === "string") {
      if (PORTAL_ID.test(v)) bad.push(path);
    } else if (Array.isArray(v)) {
      for (const [i, x] of v.entries()) walk(x, `${path}/${i}`);
    } else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, `${path}/${k}`);
  };
  recipe.steps.forEach((s, n) => {
    if ("ws" in s.input) bad.push(`/steps/${n}/input/ws`);
    walk(s.input, `/steps/${n}/input`);
  });
  return bad;
}
