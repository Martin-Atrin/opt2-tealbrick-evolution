-- 0.2.2: the Kanban detector runs in the background (every 15 min, C85 app-initiated companion call) and on demand.
-- One row: the result of the last scan, for the owner's Suggestions page.
CREATE TABLE detector_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_at INTEGER NOT NULL,
  trigger_kind TEXT NOT NULL CHECK (trigger_kind IN ('background', 'owner')),
  kanban TEXT NOT NULL CHECK (kanban IN ('ok', 'unavailable')),
  message TEXT,
  issues_seen INTEGER NOT NULL,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL
);
