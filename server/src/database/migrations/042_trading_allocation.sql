-- 042_trading_allocation.sql - CRAB User Journey v1 (locked). The user
-- always thinks in percentages (25/50/75/100/custom) - allocation_pct
-- is the real, authoritative setting; trading_bot_config.initial_capital
-- (unchanged, still the one field the paper-trading engine reads) is
-- recomputed as deposited_balance_usd * allocation_pct / 100 on every
-- deposit/withdraw/allocation change (services/walletService.js,
-- services/tradingBotService.js's setAllocation()). Existing users
-- default to 100% - their current initial_capital is unaffected until
-- they touch Allocation themselves.

ALTER TABLE trading_bot_config ADD COLUMN allocation_pct REAL NOT NULL DEFAULT 100;
