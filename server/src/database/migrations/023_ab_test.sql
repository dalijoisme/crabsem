-- 023_ab_test.sql - isolated tables for the Regular vs High Throughput
-- comparison test. Deliberately SEPARATE from trading_bot_positions/
-- trading_bot_trades - this is a one-off side-by-side test with its own
-- $100 starting capital per profile, and must never mix with or disturb
-- the real Trading Bot's own state/history.

CREATE TABLE IF NOT EXISTS ab_test_run (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    status TEXT NOT NULL DEFAULT 'STOPPED',  -- RUNNING | STOPPED
    started_at TEXT,
    stopped_at TEXT
);

INSERT OR IGNORE INTO ab_test_run (id, status) VALUES (1, 'STOPPED');

CREATE TABLE IF NOT EXISTS ab_test_positions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    profile TEXT NOT NULL,               -- 'REGULAR' | 'HIGH_THROUGHPUT'
    token_address TEXT NOT NULL,
    token_symbol TEXT,
    entry_price REAL NOT NULL,
    current_price REAL,
    size_usd REAL NOT NULL,
    confidence REAL,
    target_price REAL,
    target_market_cap REAL,
    stop_loss_price REAL,
    stop_loss_market_cap REAL,
    mfe_pct REAL DEFAULT 0,
    mae_pct REAL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'OPEN', -- OPEN | CLOSED
    opened_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    closed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_ab_test_positions_profile_status ON ab_test_positions(profile, status);
CREATE INDEX IF NOT EXISTS idx_ab_test_positions_profile_token ON ab_test_positions(profile, token_address);

CREATE TABLE IF NOT EXISTS ab_test_trades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    profile TEXT NOT NULL,
    token_address TEXT NOT NULL,
    token_symbol TEXT,
    entry_price REAL,
    exit_price REAL,
    size_usd REAL,
    roi_pct REAL,
    fee_usd REAL,
    reason TEXT,
    opened_at TEXT,
    closed_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_ab_test_trades_profile ON ab_test_trades(profile, closed_at);

-- Real equity curve, one row per profile per cycle - the only honest
-- way to compute max drawdown (unrealized swings matter, not just
-- realized closes).
CREATE TABLE IF NOT EXISTS ab_test_equity_snapshot (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    profile TEXT NOT NULL,
    equity REAL NOT NULL,
    taken_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_ab_test_equity_profile ON ab_test_equity_snapshot(profile, taken_at);
