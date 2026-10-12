// Suggestions page: review what agents (and the Kanban detector) suggest; decide; start a draft from an approved one.
import { Button, Field, Notice, Tabs, Tag, TextInput } from "@opt2-tealbrick/ui";
import { useCallback, useEffect, useState } from "react";
import { errorText, type Out, person } from "./ops.ts";

type Status = "open" | "approved" | "rejected" | "archived";
type Filter = Status | "all";
const TONE: Record<Status, "action" | "ok" | "blocked" | "neutral"> = { open: "action", approved: "ok", rejected: "blocked", archived: "neutral" };

export function Suggestions({ names, onDraft }: { names: (id: string | null) => string; onDraft: (draftId: string) => void }) {
  const [filter, setFilter] = useState<Filter>("open");
  const [rows, setRows] = useState<Out<"review_suggestions">["suggestions"]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [scanStatus, setScanStatus] = useState<Out<"detector_status"> | null>(null);

  const load = useCallback(async () => {
    const out = await person("review_suggestions", filter === "all" ? {} : { status: filter });
    setRows(out.suggestions);
    setScanStatus(await person("detector_status", {}));
  }, [filter]);
  useEffect(() => {
    load().catch((e) => setNotice(errorText(e)));
  }, [load]);

  const scan = async () => {
    setBusy(true);
    try {
      const r = await person("detector_scan", {});
      setNotice(
        r.kanban === "ok"
          ? `Kanban scan: ${r.issuesSeen} done issues read, ${r.created.length} new suggestion(s), ${r.updated.length} updated.`
          : (r.message ?? "Kanban is not available."),
      );
      await load();
    } catch (e) {
      setNotice(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="tb-stack">
      <p className="tb-muted">
        Agents suggest a workflow when they repeat work. Evolution also reads done Kanban issues and suggests work that one agent finished at least three times. Evolution sees done
        work only in the projects you share with it in Kanban (shared projects, or projects you grant to Evolution on Kanban's scopes page). Nothing runs until you review it.
      </p>
      <div className="tb-row">
        <Tabs<Filter>
          label="Status"
          tabs={[
            { value: "open", label: "To review" },
            { value: "approved", label: "Approved" },
            { value: "rejected", label: "Rejected" },
            { value: "archived", label: "Archived" },
            { value: "all", label: "All" },
          ]}
          value={filter}
          onChange={setFilter}
        />
        <span className="tb-spacer" />
        <Button onClick={() => void scan()} disabled={busy}>
          {busy ? "Scanning" : "Scan Kanban"}
        </Button>
      </div>
      {scanStatus ? (
        <p className="tb-muted">
          {scanStatus.lastScanAt
            ? `Kanban last read ${new Date(scanStatus.lastScanAt).toLocaleString()} (${scanStatus.trigger === "owner" ? "by you" : "in the background"}): ${
                scanStatus.kanban === "ok" ? `${scanStatus.issuesSeen} done issues, ${scanStatus.created} new suggestion(s)` : (scanStatus.message ?? "not available")
              }. Evolution reads Kanban every ${scanStatus.intervalMinutes} minutes.`
            : `Evolution reads Kanban every ${scanStatus.intervalMinutes} minutes; no scan yet.`}
        </p>
      ) : null}
      {notice ? <Notice role="status">{notice}</Notice> : null}
      {rows.length === 0 ? <p>No suggestions here.</p> : null}
      <ul className="tb-stack" style={{ listStyle: "none", padding: 0 }}>
        {rows.map((s) => (
          <li key={s.id} className="tb-panel">
            <Button variant="ghost" onClick={() => setSelected(selected === s.id ? null : s.id)} aria-expanded={selected === s.id}>
              <strong>{s.title}</strong>
            </Button>{" "}
            <Tag tone={TONE[s.status]}>{s.status}</Tag> <Tag>{s.source === "detector" ? "Kanban detector" : "agent"}</Tag>{" "}
            <span className="tb-muted">
              {names(s.agentId)} · {s.evidenceCount} evidence · {new Date(s.createdAt).toLocaleDateString()}
            </span>
            {selected === s.id ? <Detail id={s.id} names={names} onChanged={load} onDraft={onDraft} /> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Detail({ id, names, onChanged, onDraft }: { id: string; names: (id: string | null) => string; onChanged: () => Promise<void>; onDraft: (id: string) => void }) {
  const [d, setD] = useState<Out<"review_suggestion"> | null>(null);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => setD(await person("review_suggestion", { id })), [id]);
  useEffect(() => {
    reload().catch((e) => setError(errorText(e)));
  }, [reload]);
  if (!d) return <p>{error ?? "Loading."}</p>;
  const s = d.suggestion;
  const decide = async (decision: "approve" | "reject" | "archive") => {
    try {
      await person("suggestion_decide", { id, decision, ...(note.trim() ? { note: note.trim() } : {}) });
      await reload();
      await onChanged();
    } catch (e) {
      setError(errorText(e));
    }
  };
  const draft = async () => {
    try {
      const created = await person("draft_create", { suggestionId: id });
      onDraft(created.id);
    } catch (e) {
      setError(errorText(e));
    }
  };
  return (
    <div className="tb-stack" style={{ marginTop: 12 }}>
      {s.summary ? <p>{s.summary}</p> : null}
      <p className="tb-muted">
        Suggested by {s.createdBy.type === "agent" ? names(s.createdBy.id) : s.createdBy.name}
        {s.agentId && s.agentId !== s.createdBy.id ? ` about the work of ${names(s.agentId)}` : ""}.
      </p>
      <h4>Evidence</h4>
      <ul>
        {s.evidence.map((e) => (
          <li key={`${e.kind}:${e.ref}`}>
            {e.kind === "kanban_issue" ? "Kanban issue" : `Receipt in ${e.product ?? "an app"}`} <code>{e.ref}</code>
            {e.title ? ` — ${e.title}` : ""}
            {e.note ? <span className="tb-muted"> ({e.note})</span> : null}
          </li>
        ))}
      </ul>
      {s.steps.length ? (
        <>
          <h4>Proposed steps</h4>
          <ol>
            {s.steps.map((st) => (
              <li key={st.id}>
                {st.title}
                {st.ops.length ? <span className="tb-muted"> — {st.ops.map((o) => `${o.product}.${o.operation}`).join(", ")}</span> : null}
              </li>
            ))}
          </ol>
        </>
      ) : null}
      <Field label="Note (optional)">
        <TextInput value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} />
      </Field>
      {error ? (
        <Notice tone="action" role="alert">
          {error}
        </Notice>
      ) : null}
      <div className="tb-row">
        {s.status !== "approved" && s.status !== "archived" ? (
          <Button variant="primary" onClick={() => void decide("approve")}>
            Approve
          </Button>
        ) : null}
        {s.status === "approved" ? (
          <Button variant="primary" onClick={() => void draft()}>
            Start a draft
          </Button>
        ) : null}
        {s.status === "open" || s.status === "approved" ? <Button onClick={() => void decide("reject")}>Reject</Button> : null}
        {s.status !== "archived" ? <Button onClick={() => void decide("archive")}>Archive</Button> : null}
      </div>
      {d.drafts.length ? <p className="tb-muted">Drafts from this suggestion: {d.drafts.map((x) => `${x.title} (${x.state})`).join(", ")}</p> : null}
      <details>
        <summary>History</summary>
        <ul>
          {d.events.map((e) => (
            <li key={`${e.at}${e.type}`}>
              {new Date(e.at).toLocaleString()} — {e.type} by {e.actor.type === "agent" ? names(e.actor.id) : e.actor.name}
              {e.note ? `: ${e.note}` : ""}
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}
