// Pattern detector (harvest of the v1 Kanban evolution evaluator: group finished work by source template or normalised
// title, skip work already covered by a suggestion, count repeats). opt2 has no run reviews, so the signal is:
// Kanban issues in status `done`, assigned to ONE agent, with the same template (or the same normalised title),
// at least N times (default 3). Kanban is read through the companion grant to `kanban.issues_list` (read only).

export const DEFAULT_MIN_REPEATS = 3;
export const KANBAN = { product: "kanban", op: "issues_list" } as const;
/** Input sent to kanban.issues_list. Kanban owns the schema; this is the documented filter (see README "Kanban"). */
export const KANBAN_QUERY = { status: "done", limit: 200 } as const;

export interface DoneIssue {
  id: string;
  title: string;
  agentId: string;
  template: string | null;
  at: string | null;
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/** The agent an issue is attributed to: its assignee if an agent, else nothing (owner work is not a Bound candidate). */
function agentOf(i: Record<string, unknown>): string | null {
  const a = i.assignee;
  if (a && typeof a === "object") {
    const o = a as Record<string, unknown>;
    if ((o.type === undefined || o.type === "agent") && str(o.id)) return str(o.id);
    return null;
  }
  return str(a) ?? str(i.assigneeId) ?? str(i.assigneeAgentId);
}

/** Tolerant reader of the kanban.issues_list output: `{issues: [...]}` or `{items: [...]}`; keeps done agent issues only. */
export function parseDoneIssues(output: unknown): DoneIssue[] {
  const o = (output && typeof output === "object" ? output : {}) as Record<string, unknown>;
  const list = Array.isArray(o.issues) ? o.issues : Array.isArray(o.items) ? o.items : [];
  const out: DoneIssue[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const i = raw as Record<string, unknown>;
    const id = str(i.id);
    const title = str(i.title);
    const agentId = agentOf(i);
    if (!id || !title || !agentId) continue;
    if (i.status !== undefined && i.status !== "done") continue;
    const tpl = i.template && typeof i.template === "object" ? str((i.template as Record<string, unknown>).id) : str(i.template);
    out.push({ id, title, agentId, template: tpl ?? str(i.templateId), at: str(i.completedAt) ?? str(i.updatedAt) });
  }
  return out;
}

/** v1 normalizeTitle (trim, lower case, collapse spaces) plus numbers → "#", so "Weekly report 41" ≈ "Weekly report 42". */
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\d+/g, "#")
    .trim()
    .replace(/\s+/g, " ");
}

export function groupKey(i: DoneIssue): string {
  return `${i.agentId}|${i.template ? `template:${i.template}` : `title:${normalizeTitle(i.title)}`}`;
}

export interface IssueGroup {
  key: string;
  agentId: string;
  template: string | null;
  issues: DoneIssue[];
}

/** Groups not-yet-covered issues; newest first inside a group (by `at`, then id). */
export function buildGroups(issues: readonly DoneIssue[], covered: ReadonlySet<string>): IssueGroup[] {
  const groups = new Map<string, IssueGroup>();
  for (const i of issues) {
    if (covered.has(i.id)) continue;
    const key = groupKey(i);
    const g = groups.get(key) ?? { key, agentId: i.agentId, template: i.template, issues: [] };
    if (!g.issues.some((x) => x.id === i.id)) g.issues.push(i);
    groups.set(key, g);
  }
  for (const g of groups.values()) g.issues.sort((a, b) => (b.at ?? "").localeCompare(a.at ?? "") || b.id.localeCompare(a.id));
  return [...groups.values()];
}

export function suggestionText(g: IssueGroup, agentName: string): { title: string; summary: string } {
  const latest = g.issues[0]?.title ?? "repeated work";
  const basis = g.template ? `the same Kanban template (${g.template})` : "the same issue title";
  return {
    title: `Make a workflow for "${latest}"`.slice(0, 200),
    summary:
      `${agentName} finished ${g.issues.length} Kanban issues with ${basis}. Repeated, finished work like this can become a reviewed workflow that a Bound agent may run. Check the evidence, then approve to start a draft.`.slice(
        0,
        2000,
      ),
  };
}
