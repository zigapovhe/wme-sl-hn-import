CREATE TABLE IF NOT EXISTS hn_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  country TEXT NOT NULL,
  added_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_hn_events_country ON hn_events(country);
CREATE INDEX IF NOT EXISTS idx_hn_events_added_at ON hn_events(added_at);
