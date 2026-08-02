-- Arjuna V4 (Sprint 11) - Part 1/2. Real ROI accounting: every field
-- here is additive, nullable, backward compatible. Legacy entry_price/
-- exit_price/roi_pct columns are UNTOUCHED and remain available as
-- analytic/display data (Part 2 explicitly allows this) - realized_roi_pct
-- becomes the new single official ROI going forward, computed from real
-- on-chain SOL amounts for LIVE trades (roi_version='v1_onchain') or the
-- equivalent simulated spent/received value for SIMULATION/benchmark
-- trades (roi_version='v1_simulated') - never a mix, always labeled.

ALTER TABLE trading_bot_positions ADD COLUMN actual_sol_spent REAL;
ALTER TABLE trading_bot_positions ADD COLUMN entry_tx_signature TEXT;
ALTER TABLE trading_bot_positions ADD COLUMN entry_block_time INTEGER;

ALTER TABLE trading_bot_trades ADD COLUMN actual_sol_spent REAL;
ALTER TABLE trading_bot_trades ADD COLUMN actual_sol_received REAL;
ALTER TABLE trading_bot_trades ADD COLUMN realized_pnl_sol REAL;
ALTER TABLE trading_bot_trades ADD COLUMN realized_roi_pct REAL;
ALTER TABLE trading_bot_trades ADD COLUMN entry_tx_signature TEXT;
ALTER TABLE trading_bot_trades ADD COLUMN exit_tx_signature TEXT;
ALTER TABLE trading_bot_trades ADD COLUMN entry_block_time INTEGER;
ALTER TABLE trading_bot_trades ADD COLUMN exit_block_time INTEGER;
ALTER TABLE trading_bot_trades ADD COLUMN roi_version TEXT;
ALTER TABLE trading_bot_trades ADD COLUMN dataset_version TEXT;

-- Part 8 - Benchmark must report the same realized_roi_pct field/
-- semantics as live trading (benchmark never has a real on-chain swap,
-- so this is always roi_version='v1_simulated' for this table, computed
-- via the exact same services/roiCalculator.js helper - never a second
-- formula).
ALTER TABLE benchmark_trades ADD COLUMN realized_roi_pct REAL;
ALTER TABLE benchmark_trades ADD COLUMN roi_version TEXT;
