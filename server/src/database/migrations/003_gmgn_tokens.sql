CREATE TABLE IF NOT EXISTS gmgn_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token_address TEXT NOT NULL UNIQUE,
    symbol TEXT,
    name TEXT,
    chain TEXT,
    market_cap REAL,
    liquidity REAL,
    price REAL,
    price_change_5m REAL,
    price_change_1h REAL,
    price_change_24h REAL,
    volume_5m REAL,
    volume_1h REAL,
    volume_24h REAL,
    buys_5m INTEGER,
    sells_5m INTEGER,
    holders INTEGER,
    fdv REAL,
    launch_time TEXT,
    last_seen TEXT,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    raw_json TEXT
);

-- token_address already has a UNIQUE constraint above, which SQLite
-- enforces via its own implicit index - no separate index needed for it.
CREATE INDEX IF NOT EXISTS idx_gmgn_tokens_symbol ON gmgn_tokens(symbol);
CREATE INDEX IF NOT EXISTS idx_gmgn_tokens_market_cap ON gmgn_tokens(market_cap);
CREATE INDEX IF NOT EXISTS idx_gmgn_tokens_volume_1h ON gmgn_tokens(volume_1h);
CREATE INDEX IF NOT EXISTS idx_gmgn_tokens_holders ON gmgn_tokens(holders);
