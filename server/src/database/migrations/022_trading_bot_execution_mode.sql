-- 022_trading_bot_execution_mode.sql - adds the Execution Mode toggle
-- (Regular / High Throughput) requested for the Trading Bot. This is
-- NOT a new engine and does not touch scoring in any way - see
-- services/tradingBotCandidateFilter.js. It only changes the ORDER
-- candidate tokens are handed to the unmodified Production V2 +
-- Quality Gate pipeline in tradingBotEngine.js.

ALTER TABLE trading_bot_config ADD COLUMN execution_mode TEXT NOT NULL DEFAULT 'REGULAR';
