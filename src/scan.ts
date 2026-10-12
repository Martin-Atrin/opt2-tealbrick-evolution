// Kanban pattern detector, run in the background every 15 min (C85: app-initiated companion call, no parentCall) and on
// demand by the owner (detector_scan). Kanban is optional: an unreachable or held Kanban is a normal answer. What
// Evolution may read follows C87: only projects the owner shares with Evolution (Kanban defaultGrants for app callers).
import { type Db, type OpContext, TbError } from "@opt2-tealbrick/miniapp-sdk";
import type * as K from "#kit";
import { buildGroups, KANBAN, KANBAN_QUERY, parseDoneIssues, suggestionText } from "./detector.ts";
import * as store from "./store.ts";

const DETECTOR: store.Actor = { type: "system", id: "detector", name: "Kanban detector" };
export type ScanTrigger = "background" | "owner";
type CallApp = OpContext["callApp"];

export function agentName(db: Db, id: string): string {
  const r = db.prepare("SELECT name FROM agent_names WHERE id = ?").get(id);
  return r ? String(r.name) : id;
}

/** Kanban evidence → suggestions (person op; Kanban is optional, its absence is a normal answer). */
async function scanOnce(db: Db, callApp: CallApp, minRepeats: number, now: number): Promise<K.DetectorScanOutput> {
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

export async function scanKanban(db: Db, callApp: CallApp, minRepeats: number, trigger: ScanTrigger = "owner", now: number = Date.now()): Promise<K.DetectorScanOutput> {
  const r = await scanOnce(db, callApp, minRepeats, now);
  db.prepare(
    "INSERT INTO detector_state (id, last_at, trigger_kind, kanban, message, issues_seen, created, updated) VALUES (1, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET last_at = excluded.last_at, trigger_kind = excluded.trigger_kind, kanban = excluded.kanban, message = excluded.message, issues_seen = excluded.issues_seen, created = excluded.created, updated = excluded.updated",
  ).run(now, trigger, r.kanban, r.message, r.issuesSeen, r.created.length, r.updated.length);
  return r;
}

export interface DetectorStatus {
  lastScanAt: string | null;
  trigger: ScanTrigger | null;
  kanban: "ok" | "unavailable" | null;
  message: string | null;
  issuesSeen: number;
  created: number;
  updated: number;
}

export function detectorStatus(db: Db): DetectorStatus {
  const r = db.prepare("SELECT * FROM detector_state WHERE id = 1").get();
  if (!r) return { lastScanAt: null, trigger: null, kanban: null, message: null, issuesSeen: 0, created: 0, updated: 0 };
  return {
    lastScanAt: new Date(Number(r.last_at)).toISOString(),
    trigger: r.trigger_kind as ScanTrigger,
    kanban: r.kanban as "ok" | "unavailable",
    message: r.message === null ? null : String(r.message),
    issuesSeen: Number(r.issues_seen),
    created: Number(r.created),
    updated: Number(r.updated),
  };
}

/** Background refresh: first scan shortly after start, then every `intervalMs`; never two scans at once; errors are
 *  logged (code only) and never stop the timer. Timers are unref'd so they never keep the process alive. */
export const DETECTOR_REFRESH_MS = 15 * 60_000;
export const FIRST_SCAN_DELAY_MS = 60_000;

export interface Refresh {
  start(ctx: { db: Db; callApp: CallApp; log: { warn(msg: string, f?: Record<string, unknown>): void } }): void;
  stop(): void;
  /** one background scan now (also what the timer runs); resolves to null when a scan is already running or stopped */
  tick(): Promise<K.DetectorScanOutput | null>;
}

export function createDetectorRefresh(opts: { intervalMs?: number; firstDelayMs?: number; minRepeats?: number } = {}): Refresh {
  let ctx: Parameters<Refresh["start"]>[0] | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let stopped = false;
  const schedule = (ms: number) => {
    if (stopped) return;
    timer = setTimeout(() => {
      void refresh.tick().finally(() => schedule(opts.intervalMs ?? DETECTOR_REFRESH_MS));
    }, ms);
    timer.unref?.();
  };
  const refresh: Refresh = {
    start(c) {
      // a restart in the same process (tests, conformance restarts) replaces the old context and timer
      if (timer) clearTimeout(timer);
      ctx = c;
      stopped = false;
      schedule(opts.firstDelayMs ?? FIRST_SCAN_DELAY_MS);
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      ctx = null;
    },
    async tick() {
      const c = ctx;
      if (!c || running || stopped) return null;
      running = true;
      try {
        return await scanKanban(c.db, c.callApp, opts.minRepeats ?? 3, "background");
      } catch (e) {
        c.log.warn("detector refresh failed", { error: e instanceof TbError ? e.code : e instanceof Error ? e.name : "unknown" });
        return null;
      } finally {
        running = false;
      }
    },
  };
  return refresh;
}
