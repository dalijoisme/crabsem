-- 064_trading_bot_fresh_universe_snapshots.sql - Fresh BUY Universe RFC
-- (approved architecture: misty-floating-quasar.md), pipeline
-- observability enhancement requested at approval. One row per
-- scheduler tick - tick-global (no user_id), since
-- scheduler/tradingBotScheduler.js's tick() builds the fresh universe
-- ONCE, shared across every due user, before any per-user profile is
-- known. Modeled directly on migration 031_benchmark_funnel.sql's
-- benchmark_funnel_snapshots, the existing proven shape for this kind
-- of per-tick funnel visibility in this codebase.

CREATE TABLE IF NOT EXISTS trading_bot_fresh_universe_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    collector_total_count INTEGER NOT NULL,
    fresh_universe_count INTEGER NOT NULL,
    max_age_seconds INTEGER NOT NULL,
    min_market_cap REAL NOT NULL,
    taken_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_trading_bot_fresh_universe_snapshots_taken_at
    ON trading_bot_fresh_universe_snapshots(taken_at);
