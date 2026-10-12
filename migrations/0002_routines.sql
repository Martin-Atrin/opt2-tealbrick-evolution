-- Step B (0.2): schedules for promoted workflows and their runs (STEP-B-DESIGN §1; v1 routines model).
-- One automation = the ONE recurrence record of a workflow for one Bound agent. Due times are computed when the
-- agent polls; nothing in Evolution starts an agent (the agent's own `tealbrick agent serve` polls routines_due).
CREATE TABLE automations (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflows (id),
  version_pin INTEGER,               -- null = follow the active version
  policy_version INTEGER NOT NULL,   -- version whose recipe the owner applied to the agent (policy_stale check)
  agent_id TEXT NOT NULL,
  cron TEXT NOT NULL,                -- 5 fields, UTC
  enabled INTEGER NOT NULL,
  misfire_grace_sec INTEGER NOT NULL,
  kanban_project TEXT,               -- null = Evolution's own Kanban project
  revision INTEGER NOT NULL,         -- bumps on every change; part of the occurrence hash
  next_due_at INTEGER NOT NULL,      -- first fire time not yet claimed or recorded as missed
  deleted_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX automations_by_agent ON automations (agent_id, deleted_at);

-- One row per occurrence = sha256([automationId, revision, dueAt]); the primary key makes claims at-most-once.
CREATE TABLE routine_runs (
  occurrence TEXT PRIMARY KEY,
  automation_id TEXT NOT NULL REFERENCES automations (id),
  revision INTEGER NOT NULL,
  due_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('claimed', 'dispatched', 'completed', 'failed', 'missed', 'uncertain')),
  claimed_by TEXT,
  workflow_id TEXT NOT NULL,
  workflow_version INTEGER,
  summary TEXT,
  kanban_issue_id TEXT,
  kanban_sync TEXT NOT NULL DEFAULT 'none' CHECK (kanban_sync IN ('none', 'pending', 'done', 'failed')),
  claimed_at INTEGER,
  updated_at INTEGER NOT NULL
);
CREATE INDEX routine_runs_by_automation ON routine_runs (automation_id, due_at DESC);
CREATE INDEX routine_runs_open ON routine_runs (status, updated_at);
