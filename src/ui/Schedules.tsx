// Schedules page (step B): run a promoted workflow on a cron schedule by one Bound agent; pause, resume, delete;
// run history. Evolution never starts the agent: the agent's own `tealbrick agent serve` (routines mode) claims runs.
import { useAgents } from "@opt2-tealbrick/miniapp-sdk/client";
import { Button, CopyBlock, Field, Notice, Select, Tag, TextInput } from "@opt2-tealbrick/ui";
import { useCallback, useEffect, useState } from "react";
import { errorText, type Out, person } from "./ops.ts";

type Automation = Out<"automations_list">["automations"][number];
const TONE = { completed: "ok", claimed: "progress", dispatched: "progress", failed: "blocked", missed: "action", uncertain: "action" } as const;
const SERVE_CONFIG = {
  format: "tealbrick.agent-serve/1",
  harness: { kind: "claude", modelKeyEnv: "ANTHROPIC_API_KEY" },
  pollSeconds: 60,
  inboxes: [],
  routines: [{ due: "evolution__routines_due", claim: "evolution__routine_claim", report: "evolution__routine_report", items: "jobs", id: "occurrence" }],
};
const when = (s: string) => `${new Date(s).toLocaleString()}`;

export function Schedules() {
  const { agents } = useAgents();
  const [rows, setRows] = useState<Automation[]>([]);
  const [workflows, setWorkflows] = useState<Out<"workflows_list">["workflows"]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ workflowId: "", agentId: "", cron: "0 8 * * 1-5", kanbanProject: "" });
  const load = useCallback(async () => setRows((await person("automations_list", {})).automations), []);
  useEffect(() => {
    load().catch((e) => setError(errorText(e)));
    person("workflows_list", {})
      .then((w) => setWorkflows(w.workflows))
      .catch(() => {});
  }, [load]);
  const bound = agents.filter((a) => a.mode === "bound");
  const name = (id: string) => agents.find((a) => a.id === id)?.name ?? id;

  const create = async () => {
    try {
      await person("automation_set", {
        workflowId: form.workflowId,
        agentId: form.agentId,
        cron: form.cron,
        ...(form.kanbanProject.trim() ? { kanbanProject: form.kanbanProject.trim() } : {}),
      });
      setError(null);
      await load();
    } catch (e) {
      setError(errorText(e));
    }
  };
  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      setError(null);
      await load();
    } catch (e) {
      setError(errorText(e));
    }
  };

  return (
    <div className="tb-stack">
      <p className="tb-muted">
        A schedule runs a promoted workflow with one Bound agent. Evolution does not start the agent: the agent's own runner (
        <code>tealbrick agent serve</code> in routines mode) asks for due runs and claims each one once. Every run is a Kanban issue assigned to the agent, in the Kanban project you choose (share it with the agent). Times are UTC.
      </p>
      <section className="tb-panel tb-stack">
        <h4>New schedule</h4>
        <div className="tb-row">
          <Field label="Workflow">
            <Select
              value={form.workflowId}
              onChange={(e) => setForm({ ...form, workflowId: e.target.value })}
              options={[{ value: "", label: "Choose a workflow" }, ...workflows.map((w) => ({ value: w.id, label: `${w.title} (v${w.activeVersion})` }))]}
            />
          </Field>
          <Field label="Bound agent" hint={bound.length ? undefined : "No Bound agent yet: apply a workflow's recipe in Portal first."}>
            <Select
              value={form.agentId}
              onChange={(e) => setForm({ ...form, agentId: e.target.value })}
              options={[{ value: "", label: "Choose an agent" }, ...bound.map((a) => ({ value: a.id, label: a.name }))]}
            />
          </Field>
          <Field label="Cron (UTC)" hint="minute hour day month weekday, e.g. 0 8 * * 1-5">
            <TextInput value={form.cron} onChange={(e) => setForm({ ...form, cron: e.target.value })} maxLength={120} />
          </Field>
          <Field
            label="Kanban project for run issues"
            hint="Use a project you share with the Bound agent in Kanban (its id), so the agent can read and comment on its runs. Empty: Evolution's own project, which the agent sees only if you share it."
          >
            <TextInput value={form.kanbanProject} onChange={(e) => setForm({ ...form, kanbanProject: e.target.value })} maxLength={64} />
          </Field>
        </div>
        <div>
          <Button variant="primary" disabled={!form.workflowId || !form.agentId} onClick={() => void create()}>
            Create schedule
          </Button>
        </div>
      </section>
      {error ? (
        <Notice tone="action" role="alert">
          {error}
        </Notice>
      ) : null}
      {rows.length === 0 ? <p>No schedules yet.</p> : null}
      <ul className="tb-stack" style={{ listStyle: "none", padding: 0 }}>
        {rows.map((a) => (
          <li key={a.id} className="tb-panel tb-stack">
            <div className="tb-row">
              <Button variant="ghost" onClick={() => setOpen(open === a.id ? null : a.id)} aria-expanded={open === a.id}>
                <strong>{a.workflowTitle}</strong>
              </Button>
              <Tag tone={a.enabled ? "ok" : "neutral"}>{a.enabled ? "active" : "paused"}</Tag>
              <span className="tb-muted">
                {name(a.agentId)} · <code>{a.cron}</code> · next {when(a.effectiveNextDueAt)} · {a.versionPin ? `pinned v${a.versionPin}` : "active version"} · Kanban {a.kanbanProject ?? "Evolution's own project"}
              </span>
              <span className="tb-spacer" />
              <Button size="sm" onClick={() => void act(() => person("automation_pause", { id: a.id, revision: a.revision, paused: a.enabled }))}>
                {a.enabled ? "Pause" : "Resume"}
              </Button>
              <Button size="sm" variant="danger" onClick={() => void act(() => person("automation_delete", { id: a.id, revision: a.revision }))}>
                Delete
              </Button>
            </div>
            {a.missedSince ? (
              <Notice tone="action" role="status">
                Runs were missed since {when(a.missedSince)}: the agent's runner did not claim them in time. Check that tealbrick agent serve is running.
              </Notice>
            ) : null}
            {open === a.id ? <Runs id={a.id} /> : null}
          </li>
        ))}
      </ul>
      <details>
        <summary>Runner configuration for the Bound agent's machine</summary>
        <p className="tb-muted">Save as a file and start the runner with it on the machine where the Bound agent is connected (tealbrick agent serve).</p>
        <CopyBlock text={JSON.stringify(SERVE_CONFIG, null, 2)} label="Copy runner configuration" />
      </details>
    </div>
  );
}

function Runs({ id }: { id: string }) {
  const [runs, setRuns] = useState<Out<"runs_list">["runs"] | null>(null);
  useEffect(() => {
    person("runs_list", { automationId: id, limit: 50 })
      .then((r) => setRuns(r.runs))
      .catch(() => setRuns([]));
  }, [id]);
  if (!runs) return <p>Loading runs.</p>;
  if (runs.length === 0) return <p>No runs yet.</p>;
  return (
    <table>
      <thead>
        <tr>
          <th scope="col">Due</th>
          <th scope="col">Status</th>
          <th scope="col">Version</th>
          <th scope="col">Kanban</th>
          <th scope="col">Summary</th>
        </tr>
      </thead>
      <tbody>
        {runs.map((r) => (
          <tr key={r.occurrence}>
            <td>{when(r.dueAt)}</td>
            <td>
              <Tag tone={TONE[r.status]}>{r.status}</Tag>
            </td>
            <td>{r.workflowVersion ? `v${r.workflowVersion}` : ""}</td>
            <td>{r.kanbanIssueId ? <code>{r.kanbanIssueId}</code> : r.kanbanSync === "failed" ? "not recorded" : ""}</td>
            <td>{r.summary ?? ""}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
