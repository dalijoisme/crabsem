-- 055_trading_bot_config_sizing.sql - Trading Configuration sprint.
-- Separates "AI Decision Engine" (Strategy Profile - min_confidence,
-- weights, tiers, cooldowns, etc, still profile-owned) from "Trading
-- Configuration" (position sizing, max open positions - now genuinely
-- user-controlled, independent of which profile is active).
--
-- position_sizing_mode/fixed_position_size_usd: adds a fixed-USD sizing
-- option alongside the existing percent-of-balance mode
-- (position_size_pct, unchanged column). Default 'PERCENT' is
-- byte-identical to every existing account's current behavior - nothing
-- changes until a user explicitly visits the new Trading Configuration
-- page.
--
-- trading_config_customized_at: same "stamped only on a deliberate user
-- action" convention already proven by strategy_selected_at/
-- allocation_set_at - null means "never customized, profile switches may
-- still seed position_size_pct/max_position_size/max_open_positions as
-- defaults"; once set, a later profile switch must never overwrite these
-- three fields again.

ALTER TABLE trading_bot_config ADD COLUMN position_sizing_mode TEXT NOT NULL DEFAULT 'PERCENT';
ALTER TABLE trading_bot_config ADD COLUMN fixed_position_size_usd REAL;
ALTER TABLE trading_bot_config ADD COLUMN trading_config_customized_at TEXT;
