-- Admin Dashboard V2 (CEO Dashboard) support.
--
-- 1) Composite indexes for the global date filter - every CEO section
-- filters prediction_history by prediction_time AND, frequently,
-- also by recommendation or status in the same query (e.g. "STRONG
-- BUY predictions between two dates"). Migration 010 already indexed
-- status/recommendation/prediction_time individually; SQLite can only
-- use one index per simple range scan, so a query filtering on BOTH
-- recommendation and a date range was falling back to a full table
-- scan filtered by recommendation first. These composite indexes
-- (leading column matches the equality filter, trailing column
-- matches the date range) make that plan an index range scan instead.

CREATE INDEX IF NOT EXISTS idx_prediction_history_recommendation_time
    ON prediction_history(recommendation, prediction_time);

CREATE INDEX IF NOT EXISTS idx_prediction_history_status_time
    ON prediction_history(status, prediction_time);

-- Same reasoning for wallets.last_seen (Section 5's date-filtered
-- category leaderboard: "Smart Money wallets active between two
-- dates, ranked by score"). idx_wallets_label (from migration 007)
-- already covers the category filter alone; this composite index
-- covers category + date-range together, and idx_wallets_label_score
-- covers the label+ORDER BY score pattern every wallet leaderboard
-- query (not just the CEO dashboard) already uses, avoiding SQLite's
-- "USE TEMP B-TREE FOR ORDER BY" fallback for that common case.

CREATE INDEX IF NOT EXISTS idx_wallets_label_last_seen
    ON wallets(primary_label, last_seen);

CREATE INDEX IF NOT EXISTS idx_wallets_label_score
    ON wallets(primary_label, score);

-- 2) Engine Version History (Section 9). There was no real version-
-- tracking concept anywhere in this codebase before this sprint -
-- this table starts real, going forward, from the first row inserted
-- by the server at startup (see services/engineVersionService.js).
-- It deliberately does NOT get backfilled with invented historical
-- rows for versions that predate this table's existence - there is
-- no real data to reconstruct that from.

CREATE TABLE IF NOT EXISTS engine_version_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    version TEXT NOT NULL UNIQUE,
    deployed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    notes TEXT,

    -- Real validation snapshot AT THE MOMENT this version was first
    -- seen running - lets Section 9 show "win rate when this version
    -- went live" without re-querying prediction_history for a version
    -- that's since been superseded and whose live-at-the-time stats
    -- would otherwise be lost once newer predictions dominate the
    -- aggregate.
    prediction_count_snapshot INTEGER,
    win_rate_snapshot REAL,
    avg_roi_snapshot REAL
);
