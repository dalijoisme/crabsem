-- 025_strategy_profile.sql - CRAB Trading Bot Constitution v1.0, Final
-- Specification section 02/07. Adds the three columns Strategy Profile
-- needs on trading_bot_config. No new tables - Custom Objective is
-- stateless (see customObjectiveService.js), nothing to persist for it.
--
-- strategy_profile is the ONE user-facing control; opportunity_priority_enabled
-- and emi_enabled are DERIVED from it (see config/strategyProfileConfig.js)
-- and are never independently settable through the public API (see
-- services/tradingBotService.js's updateConfig) - kept as real columns,
-- not re-derived on every read, so tradingBotEngine.js's existing single
-- getConfig() call per cycle still returns everything it needs with zero
-- new queries.

ALTER TABLE trading_bot_config ADD COLUMN strategy_profile TEXT NOT NULL DEFAULT 'STABLE';
ALTER TABLE trading_bot_config ADD COLUMN opportunity_priority_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE trading_bot_config ADD COLUMN emi_enabled INTEGER NOT NULL DEFAULT 0;

-- Backfill: the columns above are additive, but min_confidence/
-- position_size_pct/etc already existed with their own pre-Constitution
-- defaults (60/0.90/5/etc from migration 021). Left alone, a freshly
-- migrated row would claim strategy_profile='STABLE' while its actual
-- numeric values didn't match the STABLE bundle (config/strategyProfileConfig.js)
-- at all - a labeled profile that lies about its own parameters. Applying
-- the real STABLE bundle here, once, keeps every existing install
-- self-consistent immediately after migration, with no separate manual
-- API call required.
UPDATE trading_bot_config SET
    min_confidence = 65,
    min_decay_fraction = 0.90,
    position_size_pct = 10,
    max_position_size = 100,
    max_open_positions = 5,
    cooldown_win_minutes = 10,
    cooldown_loss_minutes = 45,
    cooldown_reversal_minutes = 20,
    cooldown_default_minutes = 15
WHERE id = 1;
