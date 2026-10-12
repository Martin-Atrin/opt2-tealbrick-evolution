// Owner UI inside the ONE app shell (<AppShell> from @opt2-tealbrick/ui, SDK-API §14): Suggestions, Drafts and
// Workflows, plus the SDK's standard Holds and Agents pages. Every action here is a person op (owner only).
import { useAgents, useHolds, useSession } from "@opt2-tealbrick/miniapp-sdk/client";
import { AppShell, Button, Notice, STANDARD_PAGES, Tag } from "@opt2-tealbrick/ui";
import { useEffect, useState } from "react";
import { Drafts } from "./Drafts.tsx";
import { Schedules } from "./Schedules.tsx";
import { Suggestions } from "./Suggestions.tsx";
import { Workflows } from "./Workflows.tsx";

const NAME = "Evolution";

/** Pages by shell id → path under the base `/a/evolution/` (the SDK serves index.html for every UI path). */
const PATHS: Record<string, string> = { suggestions: "./", drafts: "./drafts", workflows: "./workflows", schedules: "./schedules", holds: "./holds", agents: "./configure" };
const APP_PAGES = [
  { id: "suggestions", label: "Suggestions" },
  { id: "drafts", label: "Drafts" },
  { id: "workflows", label: "Workflows" },
  { id: "schedules", label: "Schedules" },
];
const PAGES = [...APP_PAGES, ...STANDARD_PAGES.filter((p) => p.id in PATHS)];
function pageOf(pathname: string): string {
  const last = pathname.replace(/\/+$/, "").split("/").pop() ?? "";
  return last === "configure" ? "agents" : last in PATHS ? last : "suggestions";
}

function Holds() {
  const { holds, loading, decide } = useHolds({ status: "held" });
  if (loading) return <p>Loading holds.</p>;
  if (holds.length === 0) return <p>No calls wait for your approval.</p>;
  return (
    <ul>
      {holds.map((h) => (
        <li key={h.id}>
          <strong>{h.caller.name}</strong> {h.summary} <Tag tone="action">{h.op}</Tag>
          {h.view ? <pre>{h.view}</pre> : null}
          <Button variant="primary" onClick={() => void decide(h.id as Parameters<typeof decide>[0], "approve")}>
            Approve
          </Button>{" "}
          <Button onClick={() => void decide(h.id as Parameters<typeof decide>[0], "deny")}>Deny</Button>
        </li>
      ))}
    </ul>
  );
}

function Agents({ agents, loading }: ReturnType<typeof useAgents>) {
  if (loading) return <p>Loading agents.</p>;
  if (agents.length === 0) return <p>No agents are connected to this app.</p>;
  return (
    <ul>
      {agents.map((a) => (
        <li key={a.id}>
          {a.name} <Tag>{a.mode}</Tag>
        </li>
      ))}
    </ul>
  );
}

export function App() {
  const { principal, status, signOut } = useSession();
  const directory = useAgents();
  const [page, setPage] = useState(() => pageOf(globalThis.location.pathname));
  const [openDraft, setOpenDraft] = useState<string | null>(null);
  const [openWorkflow, setOpenWorkflow] = useState<string | null>(null);
  useEffect(() => {
    const onPop = () => setPage(pageOf(globalThis.location.pathname));
    globalThis.addEventListener("popstate", onPop);
    return () => globalThis.removeEventListener("popstate", onPop);
  }, []);
  const navigate = (id: string) => {
    globalThis.history.pushState(null, "", PATHS[id]);
    setPage(id);
  };
  const names = (id: string | null) => (id ? (directory.agents.find((a) => a.id === id)?.name ?? id) : "the owner");
  const content = (() => {
    switch (page) {
      case "drafts":
        return (
          <Drafts
            openId={openDraft}
            onPromoted={(wf) => {
              setOpenWorkflow(wf);
              navigate("workflows");
            }}
          />
        );
      case "workflows":
        return <Workflows openId={openWorkflow} />;
      case "schedules":
        return <Schedules />;
      case "holds":
        return <Holds />;
      case "agents":
        return <Agents {...directory} />;
      default:
        return (
          <Suggestions
            names={names}
            onDraft={(id) => {
              setOpenDraft(id);
              navigate("drafts");
            }}
          />
        );
    }
  })();
  return (
    <AppShell
      title={NAME}
      pages={PAGES}
      current={page}
      onNavigate={navigate}
      actions={
        status === "signed_in" && principal ? (
          <Button onClick={() => void signOut()}>Sign out</Button>
        ) : (
          <Tag tone={status === "loading" ? "progress" : "action"}>{status === "loading" ? "Loading" : "Signed out"}</Tag>
        )
      }
      banner={
        status === "signed_out" ? (
          <Notice tone="action" role="alert">
            Open this app from Portal to sign in.
          </Notice>
        ) : null
      }
    >
      {status === "signed_out" ? null : content}
    </AppShell>
  );
}
