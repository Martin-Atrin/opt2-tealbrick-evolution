-- Baseline (SDK-API §7.1): forward-only, one transaction per file, never edited after release.
-- App tables only; `tb_*` names are reserved for the SDK. JSON columns hold arrays/objects validated by the handlers.

-- A suggestion: "this repeated work could become a workflow" (from an agent or from the Kanban detector).
CREATE TABLE suggestions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('agent', 'detector')),
  status TEXT NOT NULL CHECK (status IN ('open', 'approved', 'rejected', 'archived')),
  agent_id TEXT,
  created_by TEXT NOT NULL,      -- JSON {type, id, name}
  evidence TEXT NOT NULL,        -- JSON [{kind, ref, product, note, title}]
  steps TEXT NOT NULL,           -- JSON [{id, title, instruction, ops}]
  group_key TEXT,                -- detector group (agent + template or normalised title); null for agent suggestions
  note TEXT,
  decided_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX suggestions_by_status ON suggestions (status, created_at DESC);
CREATE INDEX suggestions_by_creator ON suggestions (agent_id, created_at DESC);
CREATE INDEX suggestions_by_group ON suggestions (group_key, status);

CREATE TABLE suggestion_events (
  id TEXT PRIMARY KEY,
  suggestion_id TEXT NOT NULL REFERENCES suggestions (id),
  type TEXT NOT NULL,
  actor TEXT NOT NULL,           -- JSON {type, id, name}
  note TEXT,
  at INTEGER NOT NULL
);
CREATE INDEX suggestion_events_by_suggestion ON suggestion_events (suggestion_id, at);

-- Kanban issues the detector has already used as evidence (one suggestion per issue).
CREATE TABLE detector_covered (
  issue_id TEXT PRIMARY KEY,
  suggestion_id TEXT NOT NULL REFERENCES suggestions (id),
  at INTEGER NOT NULL
);

-- A draft is the owner's editable workflow text; promotion snapshots it into a version.
CREATE TABLE drafts (
  id TEXT PRIMARY KEY,
  suggestion_id TEXT REFERENCES suggestions (id),
  template_id TEXT,
  workflow_id TEXT,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  instruction TEXT NOT NULL,
  trigger_text TEXT NOT NULL,
  steps TEXT NOT NULL,           -- JSON [{id, title, instruction, ops}]
  allowed TEXT NOT NULL,         -- JSON [{product, operations, crud}]
  revision INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('open', 'promoted')),
  promoted_version INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX drafts_by_update ON drafts (updated_at DESC);

CREATE TABLE workflows (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  active_version INTEGER NOT NULL,
  draft_id TEXT NOT NULL REFERENCES drafts (id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Versions are immutable snapshots; diffs are computed between two of them.
CREATE TABLE workflow_versions (
  workflow_id TEXT NOT NULL REFERENCES workflows (id),
  version INTEGER NOT NULL,
  snapshot TEXT NOT NULL,        -- JSON {title, summary, instruction, trigger, steps, allowed}
  draft_id TEXT NOT NULL,
  draft_revision INTEGER NOT NULL,
  promoted_at INTEGER NOT NULL,
  PRIMARY KEY (workflow_id, version)
);

-- Agent names from the slice's agent directory (events.agentAdded), for readable suggestion text.
CREATE TABLE agent_names (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  seen_at INTEGER NOT NULL
);
