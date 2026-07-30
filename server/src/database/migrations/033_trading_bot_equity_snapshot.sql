-- 033_trading_bot_equity_snapshot.sql - Sprint A, Goal 1 (prove net
-- profit under real conditions). The live Trading Bot has never
-- persisted an equity curve - tradingBotService.getPortfolio()'s
-- maxDrawdownPct has always been hardcoded null with a comment saying
-- that history doesn't exist. Same shape as ab_test_equity_snapshot
-- (023_ab_test.sql), the proven pattern already used elsewhere in this
-- codebase for exactly this purpose - one row per cycle, real
-- peak-to-trough drawdown computed from a real recorded curve, never a
-- synthetic estimate.

CREATE TABLE IF NOT EXISTS trading_bot_equity_snapshot (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    equity REAL NOT NULL,
    taken_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_trading_bot_equity_taken_at ON trading_bot_equity_snapshot(taken_at);
