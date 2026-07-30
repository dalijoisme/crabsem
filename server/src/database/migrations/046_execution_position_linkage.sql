-- 046_execution_position_linkage.sql - Sprint 2 (Founder First Trade).
-- Links a real position/trade back to the exact execution that opened
-- or closed it (executions/execution_log, migration 045) - the full
-- decrypt->sign->broadcast->confirm audit trail a founder-facing
-- position should be traceable to, not just a bare price/size.
--
-- Nullable on purpose: existing SIMULATION-mode rows (every row today)
-- have no real execution behind them and never will retroactively -
-- NULL means exactly that, honestly, never backfilled. Only rows
-- opened/closed through services/tradeManager.js's real path (Sprint 2)
-- ever get a non-null value here.
--
-- No FK constraint to executions(id): trading_bot_positions/trades
-- already have no FK on token_address or similar loosely-referential
-- columns in this schema, and an execution row can in principle be
-- pruned/archived independently of the position it produced - this
-- column is a traceability pointer, not a referential-integrity
-- requirement.

ALTER TABLE trading_bot_positions ADD COLUMN execution_id INTEGER;

ALTER TABLE trading_bot_trades ADD COLUMN open_execution_id INTEGER;

ALTER TABLE trading_bot_trades ADD COLUMN close_execution_id INTEGER;
