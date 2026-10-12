// Workflows page: permanent workflows, their versions, the diff between two versions, and the Bound-agent recipe.
import { Button, CopyBlock, Field, Notice, Select, Tag, TextInput } from "@opt2-tealbrick/ui";
import { useCallback, useEffect, useState } from "react";
import { ALLOWLIST_TEXT, errorText, type Out, person } from "./ops.ts";

const HARNESSES = [
  { value: "generic-mcp", label: "Other agent (MCP)" },
  { value: "claude-desktop", label: "Claude Desktop" },
  { value: "codex-desktop", label: "Codex" },
  { value: "eve", label: "Eve agent" },
  { value: "tbd-default", label: "Teal Brick desktop app" },
];

export function Workflows({ openId }: { openId: string | null }) {
  const [rows, setRows] = useState<Out<"workflows_list">["workflows"]>([]);
  const [selected, setSelected] = useState<string | null>(openId);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    person("workflows_list", {})
      .then((r) => setRows(r.workflows))
      .catch((e) => setError(errorText(e)));
  }, []);
  useEffect(() => setSelected(openId), [openId]);
  return (
    <div className="tb-stack">
      <p className="tb-muted">A workflow is a promoted draft. Each promotion is a new version; old versions stay readable.</p>
      {error ? (
        <Notice tone="action" role="alert">
          {error}
        </Notice>
      ) : null}
      {rows.length === 0 ? <p>No workflows yet. Promote a draft first.</p> : null}
      <ul className="tb-stack" style={{ listStyle: "none", padding: 0 }}>
        {rows.map((w) => (
          <li key={w.id} className="tb-panel">
            <Button variant="ghost" onClick={() => setSelected(selected === w.id ? null : w.id)} aria-expanded={selected === w.id}>
              <strong>{w.title}</strong>
            </Button>{" "}
            <Tag tone="ok">v{w.activeVersion}</Tag> <code className="tb-muted">{w.id}</code>
            {selected === w.id ? <Detail id={w.id} /> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Detail({ id }: { id: string }) {
  const [data, setData] = useState<Out<"workflow_versions"> | null>(null);
  const [shown, setShown] = useState<number>(0);
  const [from, setFrom] = useState(1);
  const [to, setTo] = useState(1);
  const [diff, setDiff] = useState<Out<"workflow_diff"> | null>(null);
  const [agentName, setAgentName] = useState("");
  const [harness, setHarness] = useState("generic-mcp");
  const [recipe, setRecipe] = useState<Out<"recipe_export"> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    const r = await person("workflow_versions", { workflowId: id });
    setData(r);
    const last = r.workflow.activeVersion;
    setShown(last);
    setTo(last);
    setFrom(Math.max(1, last - 1));
  }, [id]);
  useEffect(() => {
    load().catch((e) => setError(errorText(e)));
  }, [load]);
  if (!data) return <p>{error ?? "Loading."}</p>;
  const v = data.versions.find((x) => x.version === shown) ?? data.versions.at(-1);
  if (!v) return null;
  const options = data.versions.map((x) => ({ value: String(x.version), label: `v${x.version} (${new Date(x.promotedAt).toLocaleDateString()})` }));

  const compare = async () => {
    try {
      setDiff(await person("workflow_diff", { workflowId: id, from, to }));
    } catch (e) {
      setError(errorText(e));
    }
  };
  const exportRecipe = async () => {
    try {
      setRecipe(await person("recipe_export", { workflowId: id, version: v.version, harnessOptionId: harness, ...(agentName.trim() ? { agentName: agentName.trim() } : {}) }));
    } catch (e) {
      setError(errorText(e));
    }
  };
  const download = () => {
    if (!recipe) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(recipe.recipe, null, 2)], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `bound-agent-${id}-v${v.version}.recipe.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="tb-stack" style={{ marginTop: 12 }}>
      <Field label="Version">
        <Select value={String(v.version)} onChange={(e) => setShown(Number(e.target.value))} options={options} />
      </Field>
      <p>{v.instruction}</p>
      <p className="tb-muted">Trigger: {v.trigger || "none set"}. Schedule runs on the Schedules page.</p>
      {v.steps.length ? (
        <ol>
          {v.steps.map((s) => (
            <li key={s.id}>
              <strong>{s.title}</strong>
              {s.instruction ? ` — ${s.instruction}` : ""}
              {s.ops.length ? <span className="tb-muted"> ({s.ops.map((o) => `${o.product}.${o.operation}`).join(", ")})</span> : null}
            </li>
          ))}
        </ol>
      ) : null}
      <h4>Allowed operations</h4>
      <Notice role="status">{ALLOWLIST_TEXT}</Notice>
      <ul>
        {v.allowed.map((a) => (
          <li key={a.product}>
            <strong>{a.product}</strong>: {a.operations.join(", ")} <span className="tb-muted">(access {a.crud.join("/")})</span>
          </li>
        ))}
      </ul>

      {data.versions.length > 1 ? (
        <section className="tb-stack">
          <h4>Compare versions</h4>
          <div className="tb-row">
            <Select aria-label="From version" value={String(from)} onChange={(e) => setFrom(Number(e.target.value))} options={options} />
            <Select aria-label="To version" value={String(to)} onChange={(e) => setTo(Number(e.target.value))} options={options} />
            <Button onClick={() => void compare()}>Compare</Button>
          </div>
          {diff ? (
            <div className="tb-stack">
              {diff.widensAccess ? <Tag tone="action">allows more</Tag> : null}
              <ul>
                {diff.fields.map((f) => (
                  <li key={f.field}>
                    {f.field} changed: <del>{f.from || "(empty)"}</del> → <ins>{f.to || "(empty)"}</ins>
                  </li>
                ))}
                {diff.steps.added.map((s) => (
                  <li key={`a${s}`}>Step added: {s}</li>
                ))}
                {diff.steps.removed.map((s) => (
                  <li key={`r${s}`}>Step removed: {s}</li>
                ))}
                {diff.steps.changed.map((s) => (
                  <li key={`c${s.id}`}>
                    Step changed: {s.title} ({s.fields.join(", ")})
                  </li>
                ))}
                {diff.operations.added.map((o) => (
                  <li key={`oa${o}`}>Operation added: {o}</li>
                ))}
                {diff.operations.removed.map((o) => (
                  <li key={`or${o}`}>Operation removed: {o}</li>
                ))}
              </ul>
              {diff.fields.length + diff.steps.added.length + diff.steps.removed.length + diff.steps.changed.length + diff.operations.added.length + diff.operations.removed.length === 0 ? (
                <p>No differences.</p>
              ) : null}
              <p className="tb-muted">{diff.notice}</p>
            </div>
          ) : null}
        </section>
      ) : null}

      <section className="tb-stack">
        <h4>Bound agent recipe (version {v.version})</h4>
        <p className="tb-muted">
          The recipe creates a new agent in Portal, sets it Bound with the operations above, and connects it to each app. You import it in Portal and apply it with one
          confirmation. Nothing is created from here.
        </p>
        <div className="tb-row">
          <Field label="Agent name">
            <TextInput value={agentName} placeholder={`${data.workflow.title} (Bound)`} onChange={(e) => setAgentName(e.target.value)} maxLength={64} />
          </Field>
          <Field label="Runs in">
            <Select value={harness} onChange={(e) => setHarness(e.target.value)} options={HARNESSES} />
          </Field>
        </div>
        <div className="tb-row">
          <Button variant="primary" onClick={() => void exportRecipe()}>
            Export recipe
          </Button>
          {recipe ? <Button onClick={download}>Download .json</Button> : null}
        </div>
        {recipe ? (
          <>
            <Notice role="status">{recipe.notice}</Notice>
            <CopyBlock text={JSON.stringify(recipe.recipe, null, 2)} label="Copy recipe" />
          </>
        ) : null}
      </section>
      {error ? (
        <Notice tone="action" role="alert">
          {error}
        </Notice>
      ) : null}
    </div>
  );
}
