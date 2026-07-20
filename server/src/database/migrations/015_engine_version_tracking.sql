-- 015_engine_version_tracking.sql - records which production engine
-- version, philosophy, and exit strategy generated each prediction, so
-- future engine versions (Production_V3, V4, ...) can be compared
-- against each other using real historical data instead of only the
-- most recent one. Additive only - existing rows get NULL for these
-- three columns (their engine was never ambiguous: every row created
-- before this migration was produced by Production_V1's Native Dynamic
-- exit, before versioning existed at all).
--
-- prediction_time (already a real, existing column since migration
-- 010) already satisfies "Prediction Timestamp" - no new column needed
-- for that.

ALTER TABLE prediction_history ADD COLUMN engine_version TEXT;
ALTER TABLE prediction_history ADD COLUMN engine_name TEXT;
ALTER TABLE prediction_history ADD COLUMN exit_strategy TEXT;

CREATE INDEX IF NOT EXISTS idx_prediction_history_engine_version ON prediction_history(engine_version);
