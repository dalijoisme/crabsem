-- 048_trading_bot_positions_rank_risk.sql - Live Decision Center / Signal
-- Center sprint. rank_at_entry/priority_score_at_entry (this cycle's own
-- real Opportunity Priority rank, opportunityPriorityService.rank() -
-- already computed, previously discarded one line after being built) and
-- risk (already computed by researchEngineFactory.js, already flowed into
-- liveByAddress, never persisted onto the position row) let Signal
-- Center/Position Detail answer "how was this ranked, how risky" without
-- re-scoring. mfe_at/mae_at record WHEN the peak/trough excursion was
-- reached (the VALUES already existed via mfe_pct/mae_pct - only the
-- timing was missing), needed for Position Detail's timeline and, later,
-- Momentum KPI's time-to-peak measurement. All five additive, nullable -
-- NULL for every position opened/tracked before this migration, and for
-- every legacy-ordering/benchmark/ab-test caller that never had a rank or
-- a real risk value to begin with - never backfilled or guessed, same
-- convention as migration 046/047.

ALTER TABLE trading_bot_positions ADD COLUMN rank_at_entry INTEGER;
ALTER TABLE trading_bot_positions ADD COLUMN priority_score_at_entry INTEGER;
ALTER TABLE trading_bot_positions ADD COLUMN risk TEXT;
ALTER TABLE trading_bot_positions ADD COLUMN mfe_at TEXT;
ALTER TABLE trading_bot_positions ADD COLUMN mae_at TEXT;
