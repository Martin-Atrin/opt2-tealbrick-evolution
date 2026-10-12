// Step B: schedules (automations) and runs, harvested from the v1 avm routines model (STEP-B-DESIGN §1):
//   occurrence = sha256([automationId, revision, dueAt]); claim = INSERT of the run row (primary key) → at-most-once;
//   due older than the misfire grace → missed (several missed periods collapse into one row, never several runs);
//   claimed > 10 min or dispatched > 30 min without a report → uncertain (never offered again; a late report may
//   still close it). Due times are computed when asked; nothing here runs on a timer and nothing starts an agent.
import { createHash } from "node:crypto";
import { ulid } from "@opt2-tealbrick/manifest";
import type { Db } from "@opt2-tealbrick/miniapp-sdk";
import { CronError, latestFireAtOrBefore, nextCronTime } from "./cron.ts";
import { diffSnapshots } from "./model.ts";
import { getVersion, getWorkflow, StoreError, snapshotOf, type Version } from "./store.ts";

export const CLAIMED_TIMEOUT_MS = 10 * 60_000;
export const DISPATCHED_TIMEOUT_MS = 30 * 60_000;
export const DEFAULT_GRACE_SEC = 120;
export type RunStatus = "claimed" | "dispatched" | "completed" | "failed" | "missed" | "uncertain";
export type ClaimReason = "already_claimed" | "missed" | "not_due" | "paused" | "not_bound" | "version_missing" | "policy_stale";

export interface Automation {
  id: string;
  workflowId: string;
  versionPin: number | null;
  policyVersion: number;
  agentId: string;
  cron: string;
  enabled: boolean;
  misfireGraceSec: number;
  kanbanProject: string | null;
  revision: number;
  nextDueAt: string;
  createdAt: string;
  updatedAt: string;
}
export interface Run {
  occurrence: string;
  automationId: string;
  workflowId: string;
  workflowVersion: number | null;
  dueAt: string;
  status: RunStatus;
  claimedBy: string | null;
  summary: string | null;
  kanbanIssueId: string | null;
  kanbanSync: "none" | "pending" | "done" | "failed";
  updatedAt: string;
}

const iso = (ms: unknown): string => new Date(Number(ms)).toISOString();
const strOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

export function occurrenceOf(automationId: string, revision: number, dueAt: number): string {
  return createHash("sha256").update(JSON.stringify([automationId, revision, dueAt])).digest("hex");
}

/** Kanban template key of a workflow's run issues (Kanban pattern `^[a-z0-9][a-z0-9._:-]*$`). */
export function runTemplateKey(workflowId: string): string {
  return `evolution:${workflowId.toLowerCase().replaceAll("_", "-")}`;
}

interface Row {
  id: string;
  workflowId: string;
  versionPin: number | null;
  policyVersion: number;
  agentId: string;
  cron: string;
  enabled: boolean;
  grace: number;
  kanbanProject: string | null;
  revision: number;
  nextDueAt: number;
  deletedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

function toRow(r: Record<string, unknown>): Row {
  return {
    id: String(r.id),
    workflowId: String(r.workflow_id),
    versionPin: r.version_pin === null ? null : Number(r.version_pin),
    policyVersion: Number(r.policy_version),
    agentId: String(r.agent_id),
    cron: String(r.cron),
    enabled: Number(r.enabled) === 1,
    grace: Number(r.misfire_grace_sec),
    kanbanProject: strOrNull(r.kanban_project),
    revision: Number(r.revision),
    nextDueAt: Number(r.next_due_at),
    deletedAt: r.deleted_at === null ? null : Number(r.deleted_at),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

function view(r: Row): Automation {
  return {
    id: r.id,
    workflowId: r.workflowId,
    versionPin: r.versionPin,
    policyVersion: r.policyVersion,
    agentId: r.agentId,
    cron: r.cron,
    enabled: r.enabled,
    misfireGraceSec: r.grace,
    kanbanProject: r.kanbanProject,
    revision: r.revision,
    nextDueAt: iso(r.nextDueAt),
    createdAt: iso(r.createdAt),
    updatedAt: iso(r.updatedAt),
  };
}

function load(db: Db, id: string): Row {
  const r = db.prepare("SELECT * FROM automations WHERE id = ? AND deleted_at IS NULL").get(id);
  if (!r) throw new StoreError("not_found", "No schedule with this id.");
  return toRow(r);
}

function next(cron: string, after: number): number {
  try {
    return nextCronTime(cron, after);
  } catch (e) {
    throw new StoreError("validation_failed", e instanceof CronError ? e.message : "Invalid schedule.", { pointer: "/cron" });
  }
}

// ── owner side ──

export interface AutomationInput {
  id?: string;
  revision?: number;
  workflowId: string;
  versionPin?: number | null;
  policyVersion?: number;
  agentId: string;
  cron: string;
  enabled?: boolean;
  misfireGraceSec?: number;
  kanbanProject?: string | null;
}

export function setAutomation(db: Db, input: AutomationInput, now: number = Date.now()): Automation {
  return db.transaction(() => {
    const wf = getWorkflow(db, input.workflowId);
    const pin = input.versionPin ?? null;
    if (pin !== null) getVersion(db, wf.id, pin);
    const policyVersion = input.policyVersion ?? pin ?? wf.activeVersion;
    getVersion(db, wf.id, policyVersion);
    const cron = input.cron.trim().replace(/\s+/g, " ");
    const firstDue = next(cron, now);
    if (!input.id) {
      const id = `aut_${ulid(now)}`;
      db.prepare(
        "INSERT INTO automations (id, workflow_id, version_pin, policy_version, agent_id, cron, enabled, misfire_grace_sec, kanban_project, revision, next_due_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)",
      ).run(id, wf.id, pin, policyVersion, input.agentId, cron, input.enabled === false ? 0 : 1, input.misfireGraceSec ?? DEFAULT_GRACE_SEC, input.kanbanProject ?? null, firstDue, now, now);
      return view(load(db, id));
    }
    const cur = load(db, input.id);
    if (input.revision !== cur.revision) throw new StoreError("revision_conflict", "The schedule changed since you opened it. Reload it.", { currentRevision: cur.revision });
    const enabled = input.enabled ?? cur.enabled;
    // a changed cron or a re-enabled schedule starts from now; otherwise keep the pending due time
    const keep = cron === cur.cron && enabled === cur.enabled;
    db.prepare(
      "UPDATE automations SET workflow_id = ?, version_pin = ?, policy_version = ?, agent_id = ?, cron = ?, enabled = ?, misfire_grace_sec = ?, kanban_project = ?, revision = revision + 1, next_due_at = ?, updated_at = ? WHERE id = ?",
    ).run(
      wf.id,
      pin,
      policyVersion,
      input.agentId,
      cron,
      enabled ? 1 : 0,
      input.misfireGraceSec ?? cur.grace,
      input.kanbanProject === undefined ? cur.kanbanProject : input.kanbanProject,
      keep ? cur.nextDueAt : firstDue,
      now,
      cur.id,
    );
    return view(load(db, cur.id));
  });
}

export function pauseAutomation(db: Db, id: string, revision: number, paused: boolean, now: number = Date.now()): Automation {
  const cur = load(db, id);
  return setAutomation(
    db,
    { id, revision, workflowId: cur.workflowId, versionPin: cur.versionPin, policyVersion: cur.policyVersion, agentId: cur.agentId, cron: cur.cron, enabled: !paused },
    now,
  );
}

export function deleteAutomation(db: Db, id: string, revision: number, now: number = Date.now()): void {
  db.transaction(() => {
    const cur = load(db, id);
    if (cur.revision !== revision) throw new StoreError("revision_conflict", "The schedule changed since you opened it. Reload it.", { currentRevision: cur.revision });
    db.prepare("UPDATE automations SET deleted_at = ?, enabled = 0, revision = revision + 1, updated_at = ? WHERE id = ?").run(now, now, id);
  });
}

export interface DueState {
  /** latest fire time ≤ now that is still inside the misfire grace (the one runnable occurrence) */
  due: number | null;
  /** first fire time that will never run (older than the grace, or skipped by a newer one) */
  missedFrom: number | null;
  /** next fire time after now */
  next: number;
}

export function dueState(a: Pick<Row, "cron" | "nextDueAt" | "grace">, now: number): DueState {
  const latest = latestFireAtOrBefore(a.cron, a.nextDueAt, now);
  if (latest === null) return { due: null, missedFrom: null, next: a.nextDueAt };
  const nxt = nextCronTime(a.cron, now);
  if (now - latest <= a.grace * 1000) return { due: latest, missedFrom: latest > a.nextDueAt ? a.nextDueAt : null, next: nxt };
  return { due: null, missedFrom: a.nextDueAt, next: nxt };
}

export interface AutomationView extends Automation {
  workflowTitle: string;
  effectiveNextDueAt: string;
  missedSince: string | null;
}

export function listAutomations(db: Db, now: number = Date.now()): AutomationView[] {
  return db
    .prepare("SELECT * FROM automations WHERE deleted_at IS NULL ORDER BY created_at DESC")
    .all()
    .map(toRow)
    .map((r) => {
      const s = dueState(r, now);
      const title = (() => {
        try {
          return getWorkflow(db, r.workflowId).title;
        } catch {
          return r.workflowId;
        }
      })();
      return {
        ...view(r),
        workflowTitle: title,
        effectiveNextDueAt: iso(s.due ?? (s.next > r.nextDueAt ? s.next : r.nextDueAt)),
        missedSince: s.missedFrom === null ? null : iso(s.missedFrom),
      };
    });
}

// ── runs ──

function toRun(r: Record<string, unknown>): Run {
  return {
    occurrence: String(r.occurrence),
    automationId: String(r.automation_id),
    workflowId: String(r.workflow_id),
    workflowVersion: r.workflow_version === null ? null : Number(r.workflow_version),
    dueAt: iso(r.due_at),
    status: r.status as RunStatus,
    claimedBy: strOrNull(r.claimed_by),
    summary: strOrNull(r.summary),
    kanbanIssueId: strOrNull(r.kanban_issue_id),
    kanbanSync: r.kanban_sync as Run["kanbanSync"],
    updatedAt: iso(r.updated_at),
  };
}

export function getRun(db: Db, occurrence: string): Run | null {
  const r = db.prepare("SELECT * FROM routine_runs WHERE occurrence = ?").get(occurrence);
  return r ? toRun(r) : null;
}

/** Owner view; stale claimed/dispatched runs are shown as uncertain even before a write op sweeps them. */
export function listRuns(db: Db, f: { automationId?: string; limit: number }, now: number = Date.now()): Run[] {
  const rows = f.automationId
    ? db.prepare("SELECT * FROM routine_runs WHERE automation_id = ? ORDER BY due_at DESC LIMIT ?").all(f.automationId, f.limit)
    : db.prepare("SELECT * FROM routine_runs ORDER BY due_at DESC LIMIT ?").all(f.limit);
  return rows.map(toRun).map((r) => (isStale(r.status, Date.parse(r.updatedAt), now) ? { ...r, status: "uncertain" as const } : r));
}

function isStale(status: string, updatedAt: number, now: number): boolean {
  return (status === "claimed" && now - updatedAt > CLAIMED_TIMEOUT_MS) || (status === "dispatched" && now - updatedAt > DISPATCHED_TIMEOUT_MS);
}

/** claimed/dispatched without a report for too long → uncertain (never offered again). Write ops only. */
export function sweep(db: Db, now: number = Date.now()): number {
  const a = db
    .prepare(
      "UPDATE routine_runs SET status = 'uncertain', summary = COALESCE(summary, 'No report from the runner in time.'), kanban_sync = CASE WHEN kanban_issue_id IS NULL THEN kanban_sync ELSE 'pending' END, updated_at = ? WHERE (status = 'claimed' AND updated_at < ?) OR (status = 'dispatched' AND updated_at < ?)",
    )
    .run(now, now - CLAIMED_TIMEOUT_MS, now - DISPATCHED_TIMEOUT_MS);
  return Number(a.changes);
}

export interface Job {
  occurrence: string;
  automationId: string;
  workflowId: string;
  version: number;
  dueAt: string;
  title: string;
}

function resolveVersion(db: Db, a: Row): Version | null {
  try {
    return getVersion(db, a.workflowId, a.versionPin ?? undefined);
  } catch {
    return null;
  }
}

/** routines_due: pure read. Bound callers only; one job per automation at most (the latest fire time in grace). */
export function dueJobs(db: Db, agentId: string, now: number = Date.now()): Job[] {
  const jobs: Job[] = [];
  for (const a of db.prepare("SELECT * FROM automations WHERE agent_id = ? AND deleted_at IS NULL AND enabled = 1").all(agentId).map(toRow)) {
    const s = dueState(a, now);
    if (s.due === null) continue;
    const occurrence = occurrenceOf(a.id, a.revision, s.due);
    if (getRun(db, occurrence)) continue;
    const v = resolveVersion(db, a);
    if (!v) continue;
    jobs.push({ occurrence, automationId: a.id, workflowId: a.workflowId, version: v.version, dueAt: iso(s.due), title: v.title });
  }
  return jobs.sort((x, y) => x.dueAt.localeCompare(y.dueAt));
}

export interface ClaimedJob extends Job {
  instruction: string;
  trigger: string;
  steps: Version["steps"];
  allowed: Version["allowed"];
  deadline: string;
  kanbanIssueId: string | null;
  kanbanProject: string | null;
}
export type ClaimResult = { claimed: true; job: ClaimedJob; automation: Automation } | { claimed: false; reason: ClaimReason };

/** routine_claim: the ONE write that turns a due occurrence into a run (primary key = at-most-once). */
export function claim(db: Db, caller: { id: string; mode: string | null }, occurrence: string, now: number = Date.now()): ClaimResult {
  return db.transaction((): ClaimResult => {
    sweep(db, now);
    if (getRun(db, occurrence)) return { claimed: false, reason: "already_claimed" };
    if (caller.mode !== "bound") return { claimed: false, reason: "not_bound" };
    for (const a of db.prepare("SELECT * FROM automations WHERE agent_id = ? AND deleted_at IS NULL").all(caller.id).map(toRow)) {
      const s = dueState(a, now);
      const missedOcc = s.missedFrom === null ? null : occurrenceOf(a.id, a.revision, s.missedFrom);
      if (s.due === null || occurrenceOf(a.id, a.revision, s.due) !== occurrence) {
        if (missedOcc === occurrence) {
          recordMissed(db, a, s.missedFrom as number, now);
          advance(db, a, s.next);
          return { claimed: false, reason: "missed" };
        }
        continue;
      }
      if (!a.enabled) return { claimed: false, reason: "paused" };
      const v = resolveVersion(db, a);
      if (!v) return { claimed: false, reason: "version_missing" };
      if (a.versionPin === null && v.version !== a.policyVersion) {
        const applied = resolveVersionAt(db, a.workflowId, a.policyVersion);
        if (!applied || diffSnapshots(snapshotOf(applied), snapshotOf(v)).widensAccess) return { claimed: false, reason: "policy_stale" };
      }
      if (s.missedFrom !== null) recordMissed(db, a, s.missedFrom, now);
      db.prepare(
        "INSERT INTO routine_runs (occurrence, automation_id, revision, due_at, status, claimed_by, workflow_id, workflow_version, claimed_at, updated_at) VALUES (?, ?, ?, ?, 'claimed', ?, ?, ?, ?, ?)",
      ).run(occurrence, a.id, a.revision, s.due, caller.id, a.workflowId, v.version, now, now);
      advance(db, a, s.next);
      return {
        claimed: true,
        automation: view(load(db, a.id)),
        job: {
          occurrence,
          automationId: a.id,
          workflowId: a.workflowId,
          version: v.version,
          dueAt: iso(s.due),
          title: v.title,
          instruction: v.instruction,
          trigger: v.trigger,
          steps: v.steps,
          allowed: v.allowed,
          deadline: iso(now + DISPATCHED_TIMEOUT_MS),
          kanbanIssueId: null,
          kanbanProject: a.kanbanProject,
        },
      };
    }
    return { claimed: false, reason: "not_due" };
  });
}

function resolveVersionAt(db: Db, workflowId: string, version: number): Version | null {
  try {
    return getVersion(db, workflowId, version);
  } catch {
    return null;
  }
}

function recordMissed(db: Db, a: Row, dueAt: number, now: number): void {
  db.prepare(
    "INSERT OR IGNORE INTO routine_runs (occurrence, automation_id, revision, due_at, status, workflow_id, summary, updated_at) VALUES (?, ?, ?, ?, 'missed', ?, ?, ?)",
  ).run(occurrenceOf(a.id, a.revision, dueAt), a.id, a.revision, dueAt, a.workflowId, "Not claimed within the misfire grace; later periods collapsed into this record.", now);
}

/** Moves the pending due time forward (never back); not a schedule change, so `revision` stays. */
function advance(db: Db, a: Row, nextDue: number): void {
  db.prepare("UPDATE automations SET next_due_at = ? WHERE id = ? AND next_due_at < ?").run(nextDue, a.id, nextDue);
}

export function setKanban(db: Db, occurrence: string, issueId: string | null, sync: Run["kanbanSync"], now: number = Date.now()): void {
  db.prepare("UPDATE routine_runs SET kanban_issue_id = COALESCE(?, kanban_issue_id), kanban_sync = ?, updated_at = MAX(updated_at, ?) WHERE occurrence = ?").run(
    issueId,
    sync,
    now,
    occurrence,
  );
}

const NEXT_STATUS: Record<RunStatus, RunStatus[]> = {
  claimed: ["dispatched", "completed", "failed", "uncertain"],
  dispatched: ["completed", "failed", "uncertain"],
  uncertain: ["completed", "failed"], // a late report from the runner is the truth
  completed: [],
  failed: [],
  missed: [],
};

export type ReportStatus = "dispatched" | "completed" | "failed" | "uncertain";
export const TERMINAL: ReadonlySet<RunStatus> = new Set(["completed", "failed", "uncertain"]);

/** routine_report: only the claimer; repeating the current status is a no-op; terminal states are final. */
export function report(db: Db, callerId: string, occurrence: string, status: ReportStatus, summary: string | null, now: number = Date.now()): { run: Run; changed: boolean } {
  return db.transaction(() => {
    sweep(db, now);
    const run = getRun(db, occurrence);
    if (!run || run.claimedBy !== callerId) throw new StoreError("not_found", "No run of yours with this occurrence.");
    if (run.status === status) return { run, changed: false };
    if (!NEXT_STATUS[run.status].includes(status)) throw new StoreError("conflict", `A ${run.status} run cannot become ${status}.`, { status: run.status });
    const sync = TERMINAL.has(status) && run.kanbanIssueId ? "pending" : run.kanbanSync;
    db.prepare("UPDATE routine_runs SET status = ?, summary = COALESCE(?, summary), kanban_sync = ?, updated_at = ? WHERE occurrence = ?").run(status, summary, sync, now, occurrence);
    return { run: getRun(db, occurrence) as Run, changed: true };
  });
}

/** Runs whose Kanban issue must still be closed (terminal, issue known, not yet synced). */
export function pendingKanban(db: Db, limit = 10): Run[] {
  return db
    .prepare("SELECT * FROM routine_runs WHERE kanban_sync = 'pending' AND kanban_issue_id IS NOT NULL ORDER BY updated_at LIMIT ?")
    .all(limit)
    .map(toRun);
}
