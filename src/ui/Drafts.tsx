// Drafts page: start a draft (template or blank), edit steps / allowed operations / trigger, promote to a version.
import { Button, Field, Notice, Select, Tag, TextInput } from "@opt2-tealbrick/ui";
import { useCallback, useEffect, useState } from "react";
import { ALLOWLIST_TEXT, errorText, type Out, person } from "./ops.ts";

type Draft = Out<"draft_get">;
type Crud = "create" | "read" | "update" | "delete";
const CRUD: Crud[] = ["create", "read", "update", "delete"];

/** "kanban.issue_create, knowledge.remember" ⇄ ops */
const opsText = (ops: { product: string; operation: string }[]) => ops.map((o) => `${o.product}.${o.operation}`).join(", ");
function parseOps(text: string): { product: string; operation: string }[] {
  return text
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((t) => {
      const [product = "", operation = ""] = t.split(".");
      return { product, operation };
    });
}

export function Drafts({ openId, onPromoted }: { openId: string | null; onPromoted: (workflowId: string) => void }) {
  const [rows, setRows] = useState<Out<"drafts_list">["drafts"]>([]);
  const [templates, setTemplates] = useState<Out<"templates_list">["templates"]>([]);
  const [selected, setSelected] = useState<string | null>(openId);
  const [template, setTemplate] = useState("");
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => setRows((await person("drafts_list", {})).drafts), []);
  useEffect(() => {
    load().catch((e) => setError(errorText(e)));
    person("templates_list", {})
      .then((t) => setTemplates(t.templates))
      .catch(() => {});
  }, [load]);
  useEffect(() => setSelected(openId), [openId]);

  const create = async () => {
    try {
      const d = await person("draft_create", template ? { templateId: template } : {});
      await load();
      setSelected(d.id);
    } catch (e) {
      setError(errorText(e));
    }
  };

  return (
    <div className="tb-stack">
      <p className="tb-muted">A draft is the workflow text you review: an instruction for the Bound agent, the steps, the trigger and the operations it may call.</p>
      <div className="tb-row">
        <Field label="Start from">
          <Select
            value={template}
            onChange={(e) => setTemplate(e.target.value)}
            options={[{ value: "", label: "Blank draft" }, ...templates.map((t) => ({ value: t.id, label: `Template: ${t.title}` }))]}
          />
        </Field>
        <Button variant="primary" onClick={() => void create()}>
          New draft
        </Button>
      </div>
      {error ? (
        <Notice tone="action" role="alert">
          {error}
        </Notice>
      ) : null}
      {rows.length === 0 ? <p>No drafts yet. Approve a suggestion or start from a template.</p> : null}
      <ul className="tb-stack" style={{ listStyle: "none", padding: 0 }}>
        {rows.map((r) => (
          <li key={r.id} className="tb-panel">
            <Button variant="ghost" onClick={() => setSelected(selected === r.id ? null : r.id)} aria-expanded={selected === r.id}>
              <strong>{r.title}</strong>
            </Button>{" "}
            <Tag tone={r.state === "promoted" ? "ok" : "progress"}>{r.state === "promoted" ? "promoted" : "editing"}</Tag> <span className="tb-muted">revision {r.revision}</span>
            {selected === r.id ? <Editor id={r.id} onSaved={load} onPromoted={onPromoted} /> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Editor({ id, onSaved, onPromoted }: { id: string; onSaved: () => Promise<void>; onPromoted: (workflowId: string) => void }) {
  const [d, setD] = useState<Draft | null>(null);
  const [form, setForm] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  useEffect(() => {
    person("draft_get", { id })
      .then((x) => {
        setD(x);
        setForm(structuredClone(x));
      })
      .catch((e) => setError(errorText(e)));
  }, [id]);
  if (!d || !form) return <p>{error ?? "Loading."}</p>;
  const set = (patch: Partial<Draft>) => setForm({ ...form, ...patch });
  const dirty = JSON.stringify(form) !== JSON.stringify(d);

  const save = async (): Promise<Draft | null> => {
    try {
      const next = await person("draft_update", {
        id,
        revision: d.revision,
        title: form.title,
        summary: form.summary,
        instruction: form.instruction,
        trigger: form.trigger,
        steps: form.steps.map((s) => ({ id: s.id, title: s.title || "Untitled step", instruction: s.instruction, ops: s.ops.filter((o) => o.product && o.operation) })),
        allowed: form.allowed.filter((a) => a.product && a.operations.length).map((a) => ({ ...a, crud: a.crud.length ? a.crud : ["read"] })),
      });
      setD(next);
      setForm(structuredClone(next));
      setError(null);
      await onSaved();
      return next;
    } catch (e) {
      setError(errorText(e));
      return null;
    }
  };
  const promote = async () => {
    const cur = dirty ? await save() : d;
    if (!cur) return;
    try {
      const r = await person("workflow_promote", { draftId: id, revision: cur.revision });
      setInfo(`Promoted: ${r.workflow.title}, version ${r.version.version}.`);
      await onSaved();
      onPromoted(r.workflow.id);
    } catch (e) {
      setError(errorText(e));
    }
  };

  return (
    <div className="tb-stack" style={{ marginTop: 12 }}>
      <Field label="Title">
        <TextInput value={form.title} onChange={(e) => set({ title: e.target.value })} maxLength={200} />
      </Field>
      <Field label="Summary">
        <TextInput value={form.summary} onChange={(e) => set({ summary: e.target.value })} maxLength={2000} />
      </Field>
      <Field label="Instruction for the Bound agent" hint="What the agent does on each run. It reads this with workflow_get.">
        <textarea className="tb-textarea" rows={4} value={form.instruction} onChange={(e) => set({ instruction: e.target.value })} maxLength={8000} />
      </Field>
      <Field label="Trigger" hint="When it should run, in words. Schedules come in a later version; nothing runs automatically yet.">
        <TextInput value={form.trigger} onChange={(e) => set({ trigger: e.target.value })} maxLength={500} />
      </Field>

      <h4>Steps</h4>
      <ol className="tb-stack">
        {form.steps.map((s, i) => (
          <li key={s.id} className="tb-stack">
            <div className="tb-row">
              <TextInput aria-label={`Step ${i + 1} title`} value={s.title} onChange={(e) => set({ steps: form.steps.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)) })} />
              <Button size="sm" onClick={() => set({ steps: form.steps.filter((_, j) => j !== i) })}>
                Remove
              </Button>
            </div>
            <TextInput
              aria-label={`Step ${i + 1} instruction`}
              placeholder="Instruction"
              value={s.instruction}
              onChange={(e) => set({ steps: form.steps.map((x, j) => (j === i ? { ...x, instruction: e.target.value } : x)) })}
            />
            <TextInput
              aria-label={`Step ${i + 1} operations`}
              placeholder="Operations, e.g. kanban.issue_create"
              defaultValue={opsText(s.ops)}
              onBlur={(e) => set({ steps: form.steps.map((x, j) => (j === i ? { ...x, ops: parseOps(e.target.value) } : x)) })}
            />
          </li>
        ))}
      </ol>
      <div>
        <Button size="sm" onClick={() => set({ steps: [...form.steps, { id: `s${Date.now().toString(36)}`, title: "", instruction: "", ops: [] }] })}>
          Add step
        </Button>
      </div>

      <h4>Allowed operations</h4>
      <Notice role="status">{ALLOWLIST_TEXT}</Notice>
      <ul className="tb-stack" style={{ listStyle: "none", padding: 0 }}>
        {form.allowed.map((a, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: rows have no id until saved; the product field itself is edited
          <li key={i} className="tb-stack">
            <div className="tb-row">
              <TextInput aria-label="App (product id)" placeholder="app, e.g. kanban" value={a.product} onChange={(e) => set({ allowed: form.allowed.map((x, j) => (j === i ? { ...x, product: e.target.value } : x)) })} />
              <Button size="sm" onClick={() => set({ allowed: form.allowed.filter((_, j) => j !== i) })}>
                Remove
              </Button>
            </div>
            <TextInput
              aria-label={`Operations in ${a.product || "this app"}`}
              placeholder="issue_create, issues_list"
              defaultValue={a.operations.join(", ")}
              onBlur={(e) => set({ allowed: form.allowed.map((x, j) => (j === i ? { ...x, operations: e.target.value.split(/[\s,]+/).filter(Boolean) } : x)) })}
            />
            <fieldset className="tb-row" style={{ border: 0, padding: 0 }}>
              <legend className="tb-muted">Access the agent needs in {a.product || "this app"}</legend>
              {CRUD.map((c) => (
                <label key={c}>
                  <input
                    type="checkbox"
                    checked={a.crud.includes(c)}
                    onChange={(e) =>
                      set({ allowed: form.allowed.map((x, j) => (j === i ? { ...x, crud: e.target.checked ? CRUD.filter((k) => k === c || x.crud.includes(k)) : x.crud.filter((k) => k !== c) } : x)) })
                    }
                  />{" "}
                  {c}
                </label>
              ))}
            </fieldset>
          </li>
        ))}
      </ul>
      <div>
        <Button size="sm" onClick={() => set({ allowed: [...form.allowed, { product: "", operations: [], crud: ["read"] }] })}>
          Add app
        </Button>
      </div>

      {error ? (
        <Notice tone="action" role="alert">
          {error}
        </Notice>
      ) : null}
      {info ? <Notice role="status">{info}</Notice> : null}
      <div className="tb-row">
        <Button onClick={() => void save()} disabled={!dirty}>
          Save
        </Button>
        <Button variant="primary" onClick={() => void promote()} disabled={!dirty && d.state === "promoted"}>
          {d.workflowId ? "Promote as next version" : "Promote to workflow"}
        </Button>
        <span className="tb-muted">Revision {d.revision}</span>
      </div>
    </div>
  );
}
