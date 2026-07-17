CREATE TABLE IF NOT EXISTS gmgn_raw_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    endpoint TEXT NOT NULL,
    request_params TEXT NOT NULL,
    raw_response TEXT NOT NULL,
    fetched_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_gmgn_raw_snapshots_endpoint ON gmgn_raw_snapshots(endpoint);
