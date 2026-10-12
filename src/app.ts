// App definition (SDK-API §3). The manifest is the only source: the SDK derives routes, input/output validation,
// OpenAPI, receipts, holds, idempotency, backups and status from it. This file registers exactly one handler per
// manifest operation id. Op ids and input/output types come from the kit that `tb-gen kit` generates from the
// manifest (`#kit`, built by `node --run kit`); none is written by hand.
//
// Audiences: agents suggest and read (their own suggestions, any promoted workflow); everything that decides,
// edits, promotes or exports is a person op, so only the workspace owner can do it (SDK-API §5).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type AppDefinition, type Caller, type Db, defineApp, type HandlerSpec, type OpContext, type SdkAppDefinition, TbError } from "@opt2-tealbrick/miniapp-sdk";
import type * as K from "#kit";
import { OP, type OpId } from "#kit";
import { buildGroups, DEFAULT_MIN_REPEATS, KANBAN, KANBAN_QUERY, parseDoneIssues, suggestionText } from "./detector.ts";
import { ALLOWLIST_NOTICE, allowedFromSteps, diffNotice, diffSnapshots, ModelError, type Snapshot } from "./model.ts";
import { buildRecipe } from "./recipe.ts";
import * as store from "./store.ts";
import { TEMPLATES } from "./templates.ts";

export const manifest = JSON.parse(readFileSync(new URL("../tealbrick.manifest.json", import.meta.url), "utf8")) as AppDefinition["manifest"];
export const migrationsDir = fileURLToPath(new URL("../migrations", import.meta.url));

/** Typed handler. The SDK validates `input` against the manifest schema before `run` and the output after it. */
function op<I, O>(spec: HandlerSpec<I, O>): HandlerSpec {
  const run = spec.run;
  // Store/model refusals become the CORE §8 envelope (404 / 409 / 422) instead of a 500.
  return {
    ...spec,
    run: async (input: I, ctx: OpContext) => {
      try {
        return await run(input, ctx);
      } catch (e) {
        throw toTbError(e);
      }
    },
  } as unknown as HandlerSpec;
}

const STATUS: Record<store.StoreError["code"], number> = { not_found: 404, conflict: 409, revision_conflict: 409, validation_failed: 422 };
export function toTbError(e: unknown): unknown {
  if (e instanceof store.StoreError) return new TbError(e.code, e.message, STATUS[e.code], e.details);
  if (e instanceof ModelError) return new TbError("validation_failed", e.message, 422, { pointer: e.pointer });
  return e;
}

function actorOf(c: Caller): store.Actor {
  return { type: c.type, id: c.id, name: c.type === "person" ? "Owner" : c.name || c.id };
}

const DETECTOR: store.Actor = { type: "system", id: "detector", name: "Kanban detector" };

export function agentName(db: Db, id: string): string {
  const r = db.prepare("SELECT name FROM agent_names WHERE id = ?").get(id);
  return r ? String(r.name) : id;
}

/** An agent sees only suggestions it made or that are about its own work. */
function visibleTo(s: store.Suggestion, c: Caller): boolean {
  return s.createdBy.id === c.id || s.agentId === c.id;
}

/** Draft text from an approved suggestion (v1: draft created from a suggestion keeps its source). */
export function snapshotFromSuggestion(s: store.Suggestion): Snapshot {
  const title = s.title.replace(/^Make a workflow for "(.*)"$/, "$1").slice(0, 200);
  return {
    title,
    summary: s.summary,
    instruction: s.steps.length ? `Do "${title}" as the owner reviewed it. Follow the steps below and use only the allowed operations.` : "",
    trigger: "",
    steps: s.steps,
    allowed: allowedFromSteps(s.steps),
  };
}

/** Kanban evidence → suggestions (person op; Kanban is optional, its absence is a normal answer). */
export async function scanKanban(db: Db, callApp: OpContext["callApp"], minRepeats: number, now: number = Date.now()): Promise<K.DetectorScanOutput> {
  let output: unknown;
  try {
    const r = await callApp(KANBAN.product, KANBAN.op, KANBAN_QUERY as unknown as K.DetectorScanInput);
    if (r.status !== "ok") return { kanban: "unavailable", message: "Kanban held the read; approve it in Kanban, then scan again.", issuesSeen: 0, created: [], updated: [] };
    output = r.output;
  } catch (e) {
    const code = e instanceof TbError ? e.code : "error";
    return { kanban: "unavailable", message: `Kanban is not reachable (${code}). Evolution still works with suggestions from agents.`, issuesSeen: 0, created: [], updated: [] };
  }
  const issues = parseDoneIssues(output);
  const created: store.SuggestionRow[] = [];
  const updated: store.SuggestionRow[] = [];
  db.transaction(() => {
    for (const g of buildGroups(issues, store.coveredIssues(db))) {
      const evidence = g.issues.map((i) => ({ kind: "kanban_issue" as const, ref: i.id, product: KANBAN.product, note: null, title: i.title }));
      const open = store.openSuggestionForGroup(db, g.key);
      if (open) {
        updated.push(store.toRow(store.addEvidence(db, open.id, evidence, DETECTOR, now)));
        store.coverIssues(db, open.id, g.issues.map((i) => i.id), now);
      } else if (g.issues.length >= minRepeats) {
        const text = suggestionText(g, g.issues.find((i) => i.agentName)?.agentName ?? agentName(db, g.agentId));
        const s = store.createSuggestion(db, { ...text, source: "detector", agentId: g.agentId, createdBy: DETECTOR, evidence, steps: [], groupKey: g.key }, now);
        store.coverIssues(db, s.id, g.issues.map((i) => i.id), now);
        created.push(store.toRow(s));
      }
    }
  });
  return { kanban: "ok", message: null, issuesSeen: issues.length, created, updated };
}

export const handlers = {
  // ── agent ──
  [OP.suggestionCreate]: op<K.SuggestionCreateInput, K.SuggestionCreateOutput>({
    // Idempotency (manifest "required") is the SDK's: a repeated key returns the stored result without calling run.
    redact: (input) => `Suggested "${input.title.slice(0, 120)}" with ${input.evidence.length} evidence reference(s)`,
    async run(input, ctx) {
      return store.createSuggestion(ctx.db, {
        title: input.title,
        summary: input.summary ?? "",
        source: "agent",
        agentId: ctx.caller.type === "agent" ? ctx.caller.id : null,
        createdBy: actorOf(ctx.caller),
        evidence: input.evidence.map((e) => ({ kind: e.kind, ref: e.ref, product: e.product ?? (e.kind === "kanban_issue" ? KANBAN.product : null), note: e.note ?? null, title: null })),
        steps: input.steps ?? [],
      });
    },
  }),
  [OP.suggestionsList]: op<K.SuggestionsListInput, K.SuggestionsListOutput>({
    async run(input, ctx) {
      return { suggestions: store.listSuggestions(ctx.db, { status: input.status, agentId: ctx.caller.id, limit: input.limit ?? 50 }).map(store.toRow) };
    },
  }),
  [OP.suggestionGet]: op<K.SuggestionGetInput, K.SuggestionGetOutput>({
    async run(input, ctx) {
      const s = store.getSuggestion(ctx.db, input.id);
      if (!visibleTo(s, ctx.caller)) throw new store.StoreError("not_found", "No suggestion with this id.");
      return s;
    },
  }),
  [OP.workflowGet]: op<K.WorkflowGetInput, K.WorkflowGetOutput>({
    async run(input, ctx) {
      return { ...store.getVersion(ctx.db, input.id, input.version), notice: ALLOWLIST_NOTICE };
    },
  }),

  // ── person (owner) ──
  [OP.reviewSuggestions]: op<K.ReviewSuggestionsInput, K.ReviewSuggestionsOutput>({
    async run(input, ctx) {
      return { suggestions: store.listSuggestions(ctx.db, { status: input.status, limit: input.limit ?? 100 }).map(store.toRow) };
    },
  }),
  [OP.reviewSuggestion]: op<K.ReviewSuggestionInput, K.ReviewSuggestionOutput>({
    async run(input, ctx) {
      const suggestion = store.getSuggestion(ctx.db, input.id);
      const drafts = store.listDrafts(ctx.db, { suggestionId: input.id }).map(draftRow);
      return { suggestion, events: store.suggestionEvents(ctx.db, input.id), drafts };
    },
  }),
  [OP.suggestionDecide]: op<K.SuggestionDecideInput, K.SuggestionDecideOutput>({
    redact: (input) => `Suggestion ${input.id}: ${input.decision}`,
    async run(input, ctx) {
      return store.decideSuggestion(ctx.db, input.id, input.decision, actorOf(ctx.caller), input.note?.trim() || null);
    },
  }),
  [OP.detectorScan]: op<K.DetectorScanInput, K.DetectorScanOutput>({
    redact: (_input, output) => (output ? `Kanban scan: ${output.kanban}, ${output.created.length} new, ${output.updated.length} updated` : "Kanban scan"),
    async run(input, ctx) {
      return scanKanban(ctx.db, ctx.callApp.bind(ctx), input.minRepeats ?? DEFAULT_MIN_REPEATS);
    },
  }),
  [OP.templatesList]: op<K.TemplatesListInput, K.TemplatesListOutput>({
    async run() {
      return { templates: TEMPLATES.map((t) => structuredClone(t)) };
    },
  }),
  [OP.draftCreate]: op<K.DraftCreateInput, K.DraftCreateOutput>({
    redact: (input) => `Draft from ${input.suggestionId ? `suggestion ${input.suggestionId}` : input.templateId ? `template ${input.templateId}` : "scratch"}`,
    async run(input, ctx) {
      if (input.suggestionId && input.templateId) throw new store.StoreError("validation_failed", "Start a draft from a suggestion or from a template, not both.");
      let snapshot: Snapshot;
      if (input.suggestionId) {
        const s = store.getSuggestion(ctx.db, input.suggestionId);
        if (s.status !== "approved") throw new store.StoreError("conflict", "Approve the suggestion before you draft a workflow from it.", { status: s.status });
        snapshot = snapshotFromSuggestion(s);
      } else if (input.templateId) {
        const t = TEMPLATES.find((x) => x.id === input.templateId);
        if (!t) throw new store.StoreError("not_found", "No template with this id.");
        const { id: _id, ...snap } = structuredClone(t);
        snapshot = snap;
      } else snapshot = { title: "New workflow", summary: "", instruction: "", trigger: "", steps: [], allowed: [] };
      if (input.title) snapshot.title = input.title;
      return store.createDraft(ctx.db, { suggestionId: input.suggestionId ?? null, templateId: input.templateId ?? null, snapshot });
    },
  }),
  [OP.draftsList]: op<K.DraftsListInput, K.DraftsListOutput>({
    async run(_input, ctx) {
      return { drafts: store.listDrafts(ctx.db).map(draftRow) };
    },
  }),
  [OP.draftGet]: op<K.DraftGetInput, K.DraftGetOutput>({
    async run(input, ctx) {
      return store.getDraft(ctx.db, input.id);
    },
  }),
  [OP.draftUpdate]: op<K.DraftUpdateInput, K.DraftUpdateOutput>({
    redact: (input) => `Draft ${input.id} edited (revision ${input.revision})`,
    async run(input, ctx) {
      const { id, revision, ...patch } = input;
      return store.updateDraft(ctx.db, id, revision, patch);
    },
  }),
  [OP.workflowPromote]: op<K.WorkflowPromoteInput, K.WorkflowPromoteOutput>({
    redact: (input, output) => (output ? `Promoted draft ${input.draftId} to ${output.workflow.id} v${output.version.version}` : `Promote draft ${input.draftId}`),
    async run(input, ctx) {
      return store.promote(ctx.db, input.draftId, input.revision);
    },
  }),
  [OP.workflowsList]: op<K.WorkflowsListInput, K.WorkflowsListOutput>({
    async run(_input, ctx) {
      return { workflows: store.listWorkflows(ctx.db) };
    },
  }),
  [OP.workflowVersions]: op<K.WorkflowVersionsInput, K.WorkflowVersionsOutput>({
    async run(input, ctx) {
      return { workflow: store.getWorkflow(ctx.db, input.workflowId), versions: store.listVersions(ctx.db, input.workflowId) };
    },
  }),
  [OP.workflowDiff]: op<K.WorkflowDiffInput, K.WorkflowDiffOutput>({
    async run(input, ctx) {
      const a = store.getVersion(ctx.db, input.workflowId, input.from);
      const b = store.getVersion(ctx.db, input.workflowId, input.to);
      const d = diffSnapshots(store.snapshotOf(a), store.snapshotOf(b));
      return { workflowId: input.workflowId, from: input.from, to: input.to, ...d, notice: diffNotice(d) };
    },
  }),
  [OP.recipeExport]: op<K.RecipeExportInput, K.RecipeExportOutput>({
    async run(input, ctx) {
      const v = store.getVersion(ctx.db, input.workflowId, input.version);
      const recipe = buildRecipe({ id: v.workflowId, version: v.version, snapshot: store.snapshotOf(v) }, { agentName: input.agentName, harnessOptionId: input.harnessOptionId });
      return {
        recipe,
        notice:
          "Save this JSON as a file. Import it in Portal (tealbrick recipe import <file>, then open the review link), check the steps and apply them with one confirmation. Portal creates the agent, sets it Bound with these operations only, and connects it to each app. Connect the agent on its machine with tealbrick agent login. " +
          ALLOWLIST_NOTICE,
      };
    },
  }),
} satisfies Record<OpId, HandlerSpec>;

function draftRow(d: store.Draft): K.DraftsListOutput["drafts"][number] {
  return { id: d.id, title: d.title, state: d.state, revision: d.revision, workflowId: d.workflowId, suggestionId: d.suggestionId, updatedAt: d.updatedAt };
}

export const definition: SdkAppDefinition = {
  manifest,
  handlers,
  migrations: migrationsDir,
  events: {
    // Agent directory (manifest needsAgentDirectory): keep names so suggestion text can say who repeated the work.
    async agentAdded(agent, ctx) {
      ctx.db.prepare("INSERT INTO agent_names (id, name, seen_at) VALUES (?, ?, ?) ON CONFLICT (id) DO UPDATE SET name = excluded.name, seen_at = excluded.seen_at").run(agent.id, agent.name, Date.now());
    },
  },
};

export const app = defineApp(definition);
