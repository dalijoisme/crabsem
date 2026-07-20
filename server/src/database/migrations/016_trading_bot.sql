-- 016_trading_bot.sql - Trading Bot Dashboard module (monitoring/control
-- UI only this phase - no real execution logic yet). Does not touch
-- Production_V1, Production_V2, or any prediction/scoring table.
--
-- trading_bot_state / trading_bot_config are single-row tables (id=1
-- fixed) - simplest honest representation of "one bot, one config" at
-- this stage. Seeded with real defaults matching the brief exactly, not
-- placeholders that will be silently outgrown.

CREATE TABLE IF NOT EXISTS trading_bot_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    status TEXT NOT NULL DEFAULT 'STOPPED',           -- STOPPED | RUNNING | PAUSED
    mode TEXT NOT NULL DEFAULT 'SIMULATION',           -- LIVE | SIMULATION
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_action TEXT,
    last_action_at TEXT
);

INSERT OR IGNORE INTO trading_bot_state (id, status, mode) VALUES (1, 'STOPPED', 'SIMULATION');

CREATE TABLE IF NOT EXISTS trading_bot_config (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    initial_capital REAL NOT NULL DEFAULT 100,
    position_size_pct REAL NOT NULL DEFAULT 20,
    max_position_size REAL NOT NULL DEFAULT 100,
    max_open_positions INTEGER NOT NULL DEFAULT 5,
    min_order_size REAL NOT NULL DEFAULT 10,
    fee_pct REAL NOT NULL DEFAULT 1,
    slippage_pct REAL NOT NULL DEFAULT 1,
    one_position_per_token INTEGER NOT NULL DEFAULT 1,
    scan_interval_seconds INTEGER NOT NULL DEFAULT 60,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO trading_bot_config (id) VALUES (1);

-- Open positions - real table, genuinely empty until an execution layer
-- exists to populate it. Never seeded with sample rows.
CREATE TABLE IF NOT EXISTS trading_bot_positions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token_address TEXT NOT NULL,
    token_symbol TEXT,
    entry_price REAL NOT NULL,
    current_price REAL,
    size_usd REAL NOT NULL,
    confidence REAL,
    exit_strategy TEXT,
    engine_version TEXT,
    status TEXT NOT NULL DEFAULT 'OPEN',
    opened_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    closed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_trading_bot_positions_status ON trading_bot_positions(status);

-- Trade history - real table, genuinely empty until real trades exist.
CREATE TABLE IF NOT EXISTS trading_bot_trades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token_address TEXT NOT NULL,
    token_symbol TEXT,
    entry_price REAL,
    exit_price REAL,
    size_usd REAL,
    roi_pct REAL,
    fee_usd REAL,
    slippage_pct REAL,
    duration_seconds INTEGER,
    reason TEXT,
    engine_version TEXT,
    tx_hash TEXT,
    opened_at TEXT,
    closed_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_trading_bot_trades_closed_at ON trading_bot_trades(closed_at);

-- Live log feed - real table, append-only. System-generated entries
-- (e.g. bot started/stopped) are inserted for real by the service layer;
-- no fabricated sample entries.
CREATE TABLE IF NOT EXISTS trading_bot_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    log_type TEXT NOT NULL,        -- BUY | SELL | INFO | WARNING | ERROR | SYSTEM
    token_symbol TEXT,
    message TEXT NOT NULL,
    meta_json TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_trading_bot_log_created_at ON trading_bot_log(created_at);
