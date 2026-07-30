-- 054_trading_bot_equity_snapshot_throughput.sql - Phase 2 (Live
-- Validation & Bottleneck Elimination). Average Simultaneous Position
-- and Average Idle Cash both need a real per-cycle sample of open
-- position count / available cash - the equity snapshot
-- tradingBotEngine.js's runCycle already inserts once every cycle is the
-- natural, zero-extra-query place to carry them, since openCount and
-- availableCash are already in scope at that exact line. Additive,
-- nullable - NULL for every snapshot taken before this migration, never
-- backfilled or guessed.

ALTER TABLE trading_bot_equity_snapshot ADD COLUMN open_position_count INTEGER;
ALTER TABLE trading_bot_equity_snapshot ADD COLUMN available_cash REAL;
