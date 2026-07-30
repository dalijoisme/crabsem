-- 044_onboarding_explicit_flags.sql - product decision: no onboarding
-- step should be silently satisfied by a default value. allocation_pct
-- defaults to 100 and strategy_profile defaults to STABLE, so a value-
-- based check ("is it set?") can never distinguish a deliberate choice
-- from an untouched default. These two nullable timestamps close that
-- gap - NULL means "never explicitly confirmed," set only by
-- services/tradingBotService.js's setAllocation() (allocation_set_at)
-- and updateConfig() when a strategy_profile switch is actually
-- present in the request (strategy_selected_at), never backfilled for
-- existing rows - every account, including ones created before this
-- migration, must explicitly confirm both at least once.

ALTER TABLE trading_bot_config ADD COLUMN allocation_set_at TEXT;
ALTER TABLE trading_bot_config ADD COLUMN strategy_selected_at TEXT;
