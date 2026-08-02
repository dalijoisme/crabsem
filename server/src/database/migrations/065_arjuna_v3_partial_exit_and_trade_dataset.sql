-- Arjuna V3 sprint. Two additive changes, both nullable/defaulted so
-- every existing row stays valid with no backfill required:
--
-- 1. Partial-exit state machine (Part 10 - TP1 sells 50%, position stays
--    OPEN with a reduced size until the final exit). size_usd already
--    means "current size" everywhere it's read - initial_size_usd is the
--    new immutable original, tp1_hit_at/tp1_price record when/where the
--    partial sell happened (null until it does), realized_pnl_usd
--    accumulates profit already locked in from partial sells before the
--    position's final close.
--
-- 2. Permanent self-learning trade dataset (Part 12/13) - every real
--    entry-time fact and exit-time outcome a completed trade needs,
--    stored directly on trading_bot_trades so a future analytics/ML
--    pass never has to re-derive it from breakdown_json. exit_classification
--    is the new MUPP ("Exit Failure" vs a genuine bad entry) label.

ALTER TABLE trading_bot_positions ADD COLUMN initial_size_usd REAL;
ALTER TABLE trading_bot_positions ADD COLUMN tp1_hit_at TEXT;
ALTER TABLE trading_bot_positions ADD COLUMN tp1_price REAL;
ALTER TABLE trading_bot_positions ADD COLUMN realized_pnl_usd REAL NOT NULL DEFAULT 0;

ALTER TABLE trading_bot_trades ADD COLUMN confidence INTEGER;
ALTER TABLE trading_bot_trades ADD COLUMN participant_score INTEGER;
ALTER TABLE trading_bot_trades ADD COLUMN market_health INTEGER;
ALTER TABLE trading_bot_trades ADD COLUMN token_age_minutes_at_entry REAL;
ALTER TABLE trading_bot_trades ADD COLUMN holders_at_entry INTEGER;
ALTER TABLE trading_bot_trades ADD COLUMN liquidity_at_entry REAL;
ALTER TABLE trading_bot_trades ADD COLUMN volume_1h_at_entry REAL;
ALTER TABLE trading_bot_trades ADD COLUMN smart_money_metrics_json TEXT;
ALTER TABLE trading_bot_trades ADD COLUMN entry_reasons_json TEXT;
ALTER TABLE trading_bot_trades ADD COLUMN risk_reasons_json TEXT;
ALTER TABLE trading_bot_trades ADD COLUMN module_scores_json TEXT;
ALTER TABLE trading_bot_trades ADD COLUMN mfe_pct REAL;
ALTER TABLE trading_bot_trades ADD COLUMN mae_pct REAL;
ALTER TABLE trading_bot_trades ADD COLUMN exit_classification TEXT;
