-- 018_decision_cycle_analytics.sql - one row per scheduler cycle,
-- summarizing the trigger-rule engine's real throughput for the Admin
-- Dashboard (Predictions created/hour, Predictions skipped + reason,
-- Average confidence, Recommendation changes, Signal upgrades/
-- downgrades, Engine throughput). Small, bounded table (one row per
-- ~60s cycle) - not per-token, so volume stays modest even at high
-- decision throughput.

CREATE TABLE decision_cycle_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cycle_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    scanned INTEGER NOT NULL DEFAULT 0,
    created INTEGER NOT NULL DEFAULT 0,
    skipped INTEGER NOT NULL DEFAULT 0,
    skip_reasons_json TEXT,
    avg_confidence REAL,
    recommendation_changes INTEGER NOT NULL DEFAULT 0,
    upgrades INTEGER NOT NULL DEFAULT 0,
    downgrades INTEGER NOT NULL DEFAULT 0,
    positions_opened INTEGER NOT NULL DEFAULT 0,
    positions_closed_on_reversal INTEGER NOT NULL DEFAULT 0,
    duration_ms INTEGER
);

CREATE INDEX idx_decision_cycle_log_cycle_at ON decision_cycle_log(cycle_at);
