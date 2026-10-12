// Seed templates (harvested from the v1 declarative workflow examples: status rollup, meeting summary, mail triage,
// source workup). v1 connector shims and runtime-bridge/shell steps are dropped: here a step is guidance plus the
// operations the Bound agent may call. Operation names are those of the opt2 apps (Knowledge, Connect) and the
// Kanban 0.1 proposal; the owner checks them in the draft before promoting.
import type { Snapshot } from "./model.ts";

export interface Template extends Snapshot {
  id: string;
}

export const TEMPLATES: readonly Template[] = [
  {
    id: "status-rollup",
    title: "Daily status rollup",
    summary: "Collect what changed on the board today and write one short rollup.",
    trigger: "Every working day at the end of the day.",
    instruction:
      "Read today's Kanban activity, write a short rollup (done, blocked, next) as one Kanban issue in the Reports project, and keep the rollup in Knowledge. Do not change other issues.",
    steps: [
      { id: "collect", title: "Collect board changes", instruction: "List issues that changed today.", ops: [{ product: "kanban", operation: "issues_list" }] },
      { id: "summarise", title: "Write the rollup", instruction: "Summarise done, blocked and next work in under 200 words.", ops: [] },
      {
        id: "record",
        title: "Record the rollup",
        instruction: "Create one rollup issue and remember the text.",
        ops: [
          { product: "kanban", operation: "issue_create" },
          { product: "knowledge", operation: "remember" },
        ],
      },
    ],
    allowed: [
      { product: "kanban", operations: ["issue_create", "issues_list"], crud: ["create", "read"] },
      { product: "knowledge", operations: ["remember"], crud: ["create", "read"] },
    ],
  },
  {
    id: "meeting-summary",
    title: "Meeting summary",
    summary: "Turn a meeting transcript into decisions, action items and follow-up issues.",
    trigger: "When the owner adds a meeting transcript to Knowledge.",
    instruction:
      "Find the newest meeting transcript, summarise decisions, action items and blockers, save the summary as a document and create one Kanban issue per action item.",
    steps: [
      {
        id: "find",
        title: "Find the transcript",
        instruction: "Search Knowledge for the newest transcript and read it.",
        ops: [
          { product: "knowledge", operation: "documents_search" },
          { product: "knowledge", operation: "document_get" },
        ],
      },
      { id: "summarise", title: "Summarise", instruction: "List decisions, action items with owners, and blockers.", ops: [] },
      { id: "save", title: "Save the summary", instruction: "Create a summary document next to the transcript.", ops: [{ product: "knowledge", operation: "document_create" }] },
      { id: "follow-up", title: "Create follow-up issues", instruction: "One issue per action item.", ops: [{ product: "kanban", operation: "issue_create" }] },
    ],
    allowed: [
      { product: "kanban", operations: ["issue_create"], crud: ["create"] },
      { product: "knowledge", operations: ["document_create", "document_get", "documents_search"], crud: ["create", "read"] },
    ],
  },
  {
    id: "inbox-triage",
    title: "Inbox triage",
    summary: "Sort new messages by urgency and report; never reply or send.",
    trigger: "Every working day in the morning.",
    instruction:
      "Read new messages in the connected inbox, sort them into urgent, reply soon, waiting, FYI and noise, and create one Kanban issue with the triage list. Never send, reply or delete anything.",
    steps: [
      {
        id: "read",
        title: "Read new messages",
        instruction: "Read unread and recent conversations.",
        ops: [
          { product: "connect", operation: "channel_inbox" },
          { product: "connect", operation: "channel_conversations" },
        ],
      },
      { id: "classify", title: "Sort by urgency", instruction: "Use the five buckets; quote at most one line per message.", ops: [] },
      { id: "report", title: "Report the triage", instruction: "Create one issue with the sorted list.", ops: [{ product: "kanban", operation: "issue_create" }] },
    ],
    allowed: [
      { product: "connect", operations: ["channel_conversations", "channel_inbox"], crud: ["read"] },
      { product: "kanban", operations: ["issue_create"], crud: ["create"] },
    ],
  },
  {
    id: "source-workup",
    title: "Source workup",
    summary: "Turn a new link into a sourced note with open questions.",
    trigger: "When the owner gives a link (manual).",
    instruction:
      "Add the link as a research source, ask research questions about it, and write one short note with sources and open questions. Create a Kanban issue if the owner must decide something.",
    steps: [
      { id: "add", title: "Add the source", instruction: "Add the link as a research source.", ops: [{ product: "knowledge", operation: "research_source_add" }] },
      { id: "ask", title: "Ask about it", instruction: "Ask what it claims, the evidence and what is missing.", ops: [{ product: "knowledge", operation: "research_ask" }] },
      { id: "note", title: "Write the note", instruction: "Write a short note with links and open questions.", ops: [{ product: "knowledge", operation: "document_create" }] },
      { id: "escalate", title: "Escalate if needed", instruction: "Create an issue only when the owner must decide.", ops: [{ product: "kanban", operation: "issue_create" }] },
    ],
    allowed: [
      { product: "kanban", operations: ["issue_create"], crud: ["create"] },
      { product: "knowledge", operations: ["document_create", "research_ask", "research_source_add"], crud: ["create", "read"] },
    ],
  },
];
