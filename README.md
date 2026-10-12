# opt2-tealbrick-evolution

Teal Brick opt2: **Evolution**, the miniapp that turns work your agents repeat into reviewed, versioned workflows,
and exports a recipe that creates a Bound agent for a workflow (product id `evolution`).

**Status: opt2 build (clean-room v2 of Teal Brick), work in progress.** This repository is part of the opt2 build and
lives under `Martin-Atrin` during the build; it moves to the Teal Brick organisation as one clean commit when opt2 is
released. It is not the current production system.

Owner lane: Lead · Evolution. 0.1 = "step A" (decision C83): suggestions, owner review, drafts, versions, diffs,
recipe export, Kanban pattern detector. 0.2 = "step B": schedules and runs claimed at most once by the Bound agent's own
runner (`tealbrick agent serve` routines mode); every run is a Kanban issue assigned to the Bound agent.

## No secrets policy

This repository is public. It must never contain secrets or personal data:

- No API keys, tokens, passwords, private keys, deployment secrets, `.env` files or connection strings. Use `.env.example` with placeholder values only.
- Runtime secrets live in the deployment platform (Railway variables) and are copied between services without printing them. Woodpecker holds no secrets (C72).
- No personal names, private agent configurations or customer data.
- Every push runs a secret scan (gitleaks step in `.woodpecker/ci.yaml`). GitHub secret scanning with push protection is enabled. Optional local guard: `pre-commit install`.
- If a secret is committed anyway: rotate it first, then remove it from history.

## What it does

```
agent repeats work ──suggestion_create (evidence: Kanban issue ids / receipt call ids, steps)──┐
Kanban done issues ──detector (same template or title, one agent, N ≥ 3)───────────────────────┤
                                                                                               ▼
owner (person ops): review → approve → draft (steps, allowed ops per product, trigger) → promote v1, v2 …
                    → diff versions → recipe_export (tealbrick.recipe/1) → owner imports + applies it in Portal
                    → a Bound agent whose grant allows only the workflow's operations
                    → schedule (cron, UTC) → the agent's runner: routines_due → routine_claim → one turn → routine_report
                    → every run = one Kanban issue assigned to the Bound agent (template evolution:<workflow id>)
```

The UI says it plainly: **the agent may call these operations** (the bridge blocks every other one); the steps are
reviewed guidance, not an enforced program. Temporal and the v1 step runner are not part of opt2.

| Operation | Audience | Purpose |
|---|---|---|
| `suggestion_create` | agent | suggest a workflow with evidence and optional steps (idempotency required) |
| `suggestions_list`, `suggestion_get` | agent | the caller's own suggestions and their status |
| `workflow_get` | agent | a promoted workflow version (what a Bound agent reads) with the allowlist notice |
| `review_suggestions`, `review_suggestion`, `suggestion_decide` | person | owner review: approve / reject / archive |
| `detector_scan` | person | read done Kanban issues (companion `kanban.issues_list`) and suggest repeated work |
| `templates_list`, `draft_create`, `drafts_list`, `draft_get`, `draft_update` | person | drafts from a suggestion, a seed template or blank; revisioned edits |
| `workflow_promote`, `workflows_list`, `workflow_versions`, `workflow_diff` | person | versions (immutable snapshots) and diffs |
| `recipe_export` | person | `agents.create` + `agents.policy_set` (bound, workflow ops) + `edges.create` per product |
| `routines_due` | agent | Bound caller's due runs; pure read, the runner's poll target (Free callers get none) |
| `routine_claim` | agent | `{occurrence}` → at most one claim ever succeeds; answers the reviewed workflow, or `claimed: false` + reason (`already_claimed`, `missed`, `not_due`, `paused`, `not_bound`, `version_missing`, `policy_stale`) |
| `routine_report` | agent | `dispatched` → `completed` / `failed` / `uncertain` (+ summary); closes the run's Kanban issue |
| `automation_set`, `automation_pause`, `automation_delete`, `automations_list`, `runs_list` | person | schedules (cron, version pin or active, applied policy version, Kanban project) and run history |

### Schedules and runs (0.2)
- occurrence = sha256 of `[automationId, revision, dueAt]`; the run row's primary key makes a claim at-most-once (v1 routines model).
- Misfire grace (default 120 s, `cronDue`): a due time not claimed in time is recorded `missed` once, missed periods collapse into that record, and the next period runs; never a burst of catch-up runs.
- `claimed` > 10 min or `dispatched` > 30 min without a report → `uncertain`, never offered again (a late report still closes it).
- Following the active version: if it allows more than the version whose recipe the owner applied (`policyVersion`), claims answer `policy_stale` until the owner applies the new recipe and updates the schedule.
- Kanban (companion `issue_create`, `issue_complete`, `issue_block`): one issue per claimed run, assigned to the Bound agent, template `evolution:<workflow id>`; the detector never suggests these. Kanban down → the run still runs (`kanbanSync: failed`).
- Run issue project: the schedule's `kanbanProject`. Use a Kanban project the owner SHARES with the Bound agent, so the agent can read and comment on its run issues (Kanban gives shared projects to agents and to Evolution). Empty = Evolution's own Kanban project, which the agent sees only if the owner shares it. Every recipe allows `kanban.issue_get` and `kanban.issue_comment_add` for this.
- Cron and the due / misfire rule: `nextCronTime` and `cronDue` from `@opt2-tealbrick/manifest` 0.1.7 (5 fields, UTC; the one shared helper, no local copy). `routines_due` only records runs that passed the grace as `missed`; it never claims.

### Kanban (soft dependency)
The manifest declares one companion: `kanban.issues_list` (read). Evolution calls it with
`{"status": "done", "limit": 200}` and reads `issues[]` with `id`, `title`, `status`, `assignee {kind, id, name}`
(Kanban 0.1; only `kind: "agent"` counts) and, if Kanban adds one later, `template` / `templateId`. Without Kanban
the scan answers `unavailable` and Evolution works with agent suggestions alone. Evolution sees done work only in the projects the
owner shares with it (Kanban shared projects, or projects granted to Evolution on Kanban's scopes page; decision C87).

### Recipe
`recipe_export` emits a `tealbrick.recipe/1` (PORTAL-API §3) with no `ws` and no concrete Portal id (`$ref` to step
0's output). The Bound agent's allowlist always includes `evolution.workflow_get`. Apply it with
`tealbrick recipe import <file>` and the review link, then one confirmation in the browser.

## Layout

| Path | Content |
|---|---|
| `tealbrick.manifest.json` | the only description of the app (ops, companion, agent directory, skill, backups, UI paths) |
| `src/app.ts` | `defineApp`: one typed handler per operation (`#kit` op ids and I/O types) |
| `src/store.ts` | suggestions, events, drafts, workflows, versions over the SDK `Db` |
| `src/model.ts` | pure rules: steps, allowlist, promotion checks, version diff |
| `src/detector.ts` | Kanban pattern detector (harvest of the v1 evaluator) |
| `src/recipe.ts` | Bound-agent recipe builder |
| `src/routines.ts` | schedules, due/claim/report, missed records, sweep (cron rule from the manifest package) |
| `src/templates.ts` | seed workflow templates |
| `src/ui/` | owner UI in `<AppShell>`: Suggestions, Drafts, Workflows, Schedules, Holds, Agents |
| `migrations/` | `0001_init.sql` (0.1), `0002_routines.sql` (0.2); forward-only, never edit a released file |
| `skills/use-evolution/SKILL.md` | agent skill: when to suggest, Bound-agent behaviour |
| `Dockerfile` | the one opt2 app Dockerfile pattern (SDK-API §15.1) |
| `.woodpecker/ci.yaml`, `.github/workflows/opt2-release.yml` | opt2 CI template ci-v9.1 (generated, do not edit) |

Scaffolded with `create-tealbrick-miniapp` 0.1.5.

## Develop

```sh
pnpm install --frozen-lockfile
pnpm typecheck && pnpm lint && pnpm test
pnpm build            # server to dist/, UI to dist/ui/assets-<hash>/
pnpm conformance      # SDK conformance suite against this app
pnpm gen              # tb-gen: openapi, kit, docs, railway (gen/, not committed)
TB_STANDALONE=1 TB_DATA_DIR=.data TB_DATA_EPHEMERAL=1 pnpm start   # app-alone mode: person UI only
```

## Release

1. Set the same version in `package.json` and `tealbrick.manifest.json`.
2. Tag `v<semver>` and push the tag. The GitHub Actions workflow builds and publishes the image and kit (C72/C76: release assets only from CI).
3. The platform signer indexes the release.

## Language

New code is TypeScript (Node 24+).
