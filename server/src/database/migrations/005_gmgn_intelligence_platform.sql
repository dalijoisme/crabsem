-- Scheduled-collection tables: real GMGN market-wide intelligence,
-- one row per (natural key), upserted on every collection cycle.

CREATE TABLE IF NOT EXISTS gmgn_trenches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    section TEXT NOT NULL,              -- as returned by GMGN: new_creation | completed | pump (their label for near_completion)
    token_address TEXT NOT NULL,
    symbol TEXT,
    name TEXT,
    chain TEXT,
    market_cap REAL,
    liquidity REAL,
    holders INTEGER,
    progress REAL,
    status TEXT,
    swaps_24h INTEGER,
    buys_24h INTEGER,
    sells_24h INTEGER,
    net_buy_24h REAL,
    rug_ratio REAL,
    top_10_holder_rate REAL,
    is_honeypot INTEGER,
    renounced_mint INTEGER,
    renounced_freeze_account INTEGER,
    sniper_count INTEGER,
    smart_degen_count INTEGER,
    creator TEXT,
    launchpad TEXT,
    launchpad_platform TEXT,
    created_timestamp INTEGER,
    raw_json TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(section, token_address)
);

CREATE INDEX IF NOT EXISTS idx_gmgn_trenches_section ON gmgn_trenches(section);
CREATE INDEX IF NOT EXISTS idx_gmgn_trenches_market_cap ON gmgn_trenches(market_cap);
CREATE INDEX IF NOT EXISTS idx_gmgn_trenches_rug_ratio ON gmgn_trenches(rug_ratio);

CREATE TABLE IF NOT EXISTS gmgn_hot_searches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token_address TEXT NOT NULL,
    symbol TEXT,
    name TEXT,
    chain TEXT NOT NULL,
    interval TEXT NOT NULL,
    rank_position INTEGER,
    price REAL,
    market_cap REAL,
    liquidity REAL,
    volume REAL,
    price_change_percent REAL,
    holders INTEGER,
    raw_json TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(chain, interval, token_address)
);

CREATE INDEX IF NOT EXISTS idx_gmgn_hot_searches_chain_interval ON gmgn_hot_searches(chain, interval);

-- Append-only: real transactions are immutable once they happen, so
-- new rows accumulate (deduped by transaction_hash) rather than being
-- upserted. Shared by both KOL and Smart Money feeds (feed_type),
-- since both are structurally the same "recent trades from tagged
-- wallets" response.

CREATE TABLE IF NOT EXISTS gmgn_activity_feed (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    feed_type TEXT NOT NULL,            -- 'kol' | 'smart_money'
    transaction_hash TEXT NOT NULL,
    chain TEXT,
    maker_address TEXT,
    maker_tags TEXT,                    -- JSON array, e.g. ["kol","padre"]
    maker_twitter TEXT,
    side TEXT,                          -- 'buy' | 'sell'
    token_address TEXT,
    token_symbol TEXT,
    amount_usd REAL,
    price_usd REAL,
    tx_timestamp INTEGER,
    raw_json TEXT NOT NULL,
    collected_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(feed_type, transaction_hash)
);

CREATE INDEX IF NOT EXISTS idx_gmgn_activity_feed_type ON gmgn_activity_feed(feed_type);
CREATE INDEX IF NOT EXISTS idx_gmgn_activity_feed_token ON gmgn_activity_feed(token_address);
CREATE INDEX IF NOT EXISTS idx_gmgn_activity_feed_maker ON gmgn_activity_feed(maker_address);

-- Append-only time series: gas price genuinely varies tick to tick.

CREATE TABLE IF NOT EXISTS gmgn_gas_price_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chain TEXT NOT NULL,
    auto_fee REAL,
    high_fee REAL,
    average_fee REAL,
    low_fee REAL,
    native_token_usd_price REAL,
    raw_json TEXT NOT NULL,
    collected_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_gmgn_gas_price_chain_time ON gmgn_gas_price_snapshots(chain, collected_at);

-- Upserted snapshot, not a log: 9 rows (one per launchpad), refreshed
-- each cycle - a growing history isn't meaningful at this granularity.

CREATE TABLE IF NOT EXISTS gmgn_launchpad_stats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    launchpad TEXT NOT NULL UNIQUE,
    token_count INTEGER,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Generic TTL cache for every ON-DEMAND (per-token / per-wallet) GMGN
-- endpoint, shared across all of them rather than one bespoke table
-- per endpoint - see repositories/gmgnOndemandCacheRepository.js.

CREATE TABLE IF NOT EXISTS gmgn_ondemand_cache (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cache_key TEXT NOT NULL UNIQUE,
    endpoint TEXT NOT NULL,
    params_json TEXT NOT NULL,
    response_json TEXT NOT NULL,
    fetched_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_gmgn_ondemand_cache_endpoint ON gmgn_ondemand_cache(endpoint);
