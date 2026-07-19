-- Learn System (Product Improvement Sprint, Part 7). The engine must
-- continuously learn from its own real prediction history - this
-- requires a real DAY-OVER-DAY rollup, which did not exist anywhere
-- in this schema before (verified: no daily_stats/metrics_snapshot
-- table existed prior to this migration). Exactly one row is upserted
-- per real UTC calendar day (same "current day only ever upserted"
-- convention as wallet_daily_snapshot, migration 007) - this table
-- starts real, going forward, from whenever this migration first
-- runs. It is NEVER backfilled with invented historical rows for days
-- that predate it - there is no real data to reconstruct that from.

CREATE TABLE IF NOT EXISTS engine_daily_metrics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    metric_date TEXT NOT NULL UNIQUE,          -- 'YYYY-MM-DD', real UTC calendar day

    prediction_count INTEGER,
    win_rate REAL,
    average_roi_pct REAL,
    tp_count INTEGER,
    sl_count INTEGER,
    expired_count INTEGER,
    open_count INTEGER,

    strong_buy_accuracy REAL,
    buy_accuracy REAL,
    hold_accuracy REAL,
    avoid_accuracy REAL,

    best_wallet_category TEXT,
    best_wallet_category_win_rate REAL,
    worst_wallet_category TEXT,
    worst_wallet_category_win_rate REAL,

    most_profitable_token_pattern TEXT,
    most_dangerous_token_pattern TEXT,

    confidence_health_status TEXT,

    computed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_engine_daily_metrics_date ON engine_daily_metrics(metric_date);
