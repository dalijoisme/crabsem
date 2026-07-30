-- 051_trading_bot_positions_lifecycle.sql - Momentum Validation System
-- sprint (Sprint 5). Full BUY lifecycle timing: crossed_5pct_at/
-- crossed_10pct_at record the first cycle a position's real ROI crosses
-- each threshold - same "compare previous stored peak to freshly
-- computed value, stamp only on a genuine new crossing" pattern already
-- proven for mfe_at/mae_at (migration 048). "Reversal start" is
-- deliberately NOT a new column here - by construction, mfe_at (the last
-- time a new peak was set) already IS the reversal-start moment for
-- whatever decline follows it, so a redundant timestamp would only ever
-- duplicate mfe_at.
--
-- siblings_json (Self-Comparison): the same cycle's OTHER real ranked
-- BUY-tier candidates that existed alongside this exact BUY - captured
-- once, at open time, purely for later observability (never read back
-- into ranking/scoring). Same optional-JSON-blob precedent as
-- breakdown_json (migration 047).
--
-- All three additive, nullable - NULL for every position opened/tracked
-- before this migration, never backfilled or guessed.

ALTER TABLE trading_bot_positions ADD COLUMN crossed_5pct_at TEXT;
ALTER TABLE trading_bot_positions ADD COLUMN crossed_10pct_at TEXT;
ALTER TABLE trading_bot_positions ADD COLUMN siblings_json TEXT;
