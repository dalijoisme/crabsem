-- Wallet Intelligence platform (CRAB's core asset is the wallet
-- database, not the token dashboard - tokens are output, wallets are
-- the knowledge base). Every table here is derived from REAL data
-- already flowing through the system (gmgn_activity_feed's real
-- KOL/smart-money trades, gmgn_trenches' real creator/dev wallets,
-- and on-demand GMGN wallet lookups) - nothing fabricated, no
-- simulated trades, no invented wallets. History is append-only by
-- design (no overwrite, no deletion) so this genuinely compounds
-- into a long-term knowledge base the longer the server runs.

-- Current aggregate state per wallet - upserted as new real trade
-- data arrives, the same "current state" pattern gmgn_tokens already
-- uses. Historical snapshots of these numbers live in
-- wallet_score_history / wallet_daily_snapshot below, so nothing is
-- lost when this row updates.

CREATE TABLE IF NOT EXISTS wallets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    wallet_address TEXT NOT NULL UNIQUE,
    chain TEXT NOT NULL DEFAULT 'sol',

    first_seen TEXT,
    last_seen TEXT,

    -- Real, observed activity (from gmgn_activity_feed + wallet_trade_positions)
    total_trades INTEGER NOT NULL DEFAULT 0,
    buy_count INTEGER NOT NULL DEFAULT 0,
    sell_count INTEGER NOT NULL DEFAULT 0,

    -- Matched round-trip positions only (see wallet_trade_positions) -
    -- these are the ones a real ROI/win-rate can be computed from.
    closed_position_count INTEGER NOT NULL DEFAULT 0,
    open_position_count INTEGER NOT NULL DEFAULT 0,
    win_count INTEGER NOT NULL DEFAULT 0,
    loss_count INTEGER NOT NULL DEFAULT 0,
    win_rate REAL,

    avg_roi_pct REAL,
    median_roi_pct REAL,
    best_roi_pct REAL,
    worst_roi_pct REAL,

    avg_holding_seconds REAL,
    avg_position_usd REAL,

    realized_profit_usd REAL,
    largest_winner_usd REAL,
    largest_loser_usd REAL,

    -- Real GMGN-observed market-cap band of the tokens this wallet
    -- actually trades, bucketed from real trade-time market caps -
    -- not a guess.
    favorite_market_cap_band TEXT,

    -- Where this wallet's real activity was first observed - which
    -- real GMGN feed(s) it has appeared in.
    source_kol INTEGER NOT NULL DEFAULT 0,
    source_smart_money INTEGER NOT NULL DEFAULT 0,
    source_dev_wallet INTEGER NOT NULL DEFAULT 0,
    source_top_trader INTEGER NOT NULL DEFAULT 0,

    -- Current computed score/label/risk - see
    -- services/walletIntelligenceService.js. History of how these
    -- changed over time lives in wallet_score_history, never
    -- overwritten there.
    score REAL,
    confidence REAL,
    primary_label TEXT,
    risk_profile TEXT,

    -- Real GMGN wallet_stats payload, when an on-demand lookup has
    -- ever been made for this wallet (sparse by nature - see
    -- gmgnOndemandService.js). Never fabricated when absent.
    gmgn_stats_json TEXT,
    gmgn_stats_fetched_at TEXT,

    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_wallets_score ON wallets(score);
CREATE INDEX IF NOT EXISTS idx_wallets_win_rate ON wallets(win_rate);
CREATE INDEX IF NOT EXISTS idx_wallets_label ON wallets(primary_label);
CREATE INDEX IF NOT EXISTS idx_wallets_last_seen ON wallets(last_seen);

-- Real matched round-trip positions (a buy paired with its
-- subsequent sell for the same wallet+token, FIFO-matched from the
-- real trade rows in gmgn_activity_feed - see
-- services/walletLedgerService.js). This is the "Wallet
-- Transactions"/"Wallet Positions"/"Wallet History" data GMGN itself
-- never hands over pre-computed - CRAB derives it from real
-- observed trades. A position with no sell yet is `status='open'`
-- and has null exit fields - never a guessed exit.

CREATE TABLE IF NOT EXISTS wallet_trade_positions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    wallet_address TEXT NOT NULL,
    token_address TEXT NOT NULL,
    token_symbol TEXT,

    entry_time TEXT NOT NULL,
    entry_price REAL,
    entry_market_cap REAL,
    entry_amount_usd REAL,

    exit_time TEXT,
    exit_price REAL,
    exit_market_cap REAL,
    exit_amount_usd REAL,

    holding_seconds REAL,
    roi_pct REAL,
    profit_usd REAL,

    status TEXT NOT NULL DEFAULT 'open', -- 'open' | 'closed'

    -- Which real activity_feed rows this position was matched from -
    -- lets any number be traced back to the exact real trades it came
    -- from, never a black box.
    entry_activity_id INTEGER,
    exit_activity_id INTEGER,

    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_wallet_positions_wallet ON wallet_trade_positions(wallet_address);
CREATE INDEX IF NOT EXISTS idx_wallet_positions_token ON wallet_trade_positions(token_address);
CREATE INDEX IF NOT EXISTS idx_wallet_positions_status ON wallet_trade_positions(status);
CREATE INDEX IF NOT EXISTS idx_wallet_positions_entry_time ON wallet_trade_positions(entry_time);

-- Append-only - every time a wallet's score/label/risk is
-- recomputed, the PREVIOUS state is preserved here rather than
-- overwritten. This is what makes "Wallet Rankings"/"Wallet
-- Timeline"/"Wallet DNA over time" possible at all.

CREATE TABLE IF NOT EXISTS wallet_score_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    wallet_address TEXT NOT NULL,
    computed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    score REAL,
    win_rate REAL,
    avg_roi_pct REAL,
    primary_label TEXT,
    risk_profile TEXT,
    total_trades INTEGER
);

CREATE INDEX IF NOT EXISTS idx_wallet_score_history_wallet_time ON wallet_score_history(wallet_address, computed_at);

-- Daily rollup per wallet - "Wallet Growth"/"Wallet Daily Snapshot".
-- One row per wallet per UTC day, upserted only within that same day
-- (never rewriting a PAST day once it's closed out - see
-- walletIntelligenceService.js).

CREATE TABLE IF NOT EXISTS wallet_daily_snapshot (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    wallet_address TEXT NOT NULL,
    snapshot_date TEXT NOT NULL, -- 'YYYY-MM-DD', UTC
    trades_count INTEGER NOT NULL DEFAULT 0,
    realized_profit_usd REAL,
    win_rate REAL,
    score REAL,
    UNIQUE(wallet_address, snapshot_date)
);

CREATE INDEX IF NOT EXISTS idx_wallet_daily_snapshot_date ON wallet_daily_snapshot(snapshot_date);

-- ============================================================
-- USER-FACING HISTORY (Recently Viewed / Watch Later / Favorites)
-- Keyed by the CRAB dashboard user's own connected+verified wallet
-- address (already required to reach dashboard.html via
-- wallet.html) - real identity already established by the existing
-- auth flow, not a new account system.
-- ============================================================

-- Append-only view log - "Recently Viewed" is the last N distinct
-- tokens per viewer, but nothing is ever deleted, so this doubles as
-- real per-user Token History with the AI's state AT THAT MOMENT
-- (Smart Recall needs exactly this to say what changed since last
-- view).

CREATE TABLE IF NOT EXISTS user_token_views (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    viewer_wallet_address TEXT NOT NULL,
    token_address TEXT NOT NULL,
    viewed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    action_at_view TEXT,
    participant_score_at_view REAL,
    confidence_at_view REAL,
    price_at_view REAL,
    market_cap_at_view REAL
);

CREATE INDEX IF NOT EXISTS idx_user_token_views_viewer_time ON user_token_views(viewer_wallet_address, viewed_at);
CREATE INDEX IF NOT EXISTS idx_user_token_views_token ON user_token_views(token_address);

CREATE TABLE IF NOT EXISTS user_watchlist (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    viewer_wallet_address TEXT NOT NULL,
    token_address TEXT NOT NULL,
    added_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(viewer_wallet_address, token_address)
);

CREATE TABLE IF NOT EXISTS user_favorites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    viewer_wallet_address TEXT NOT NULL,
    token_address TEXT NOT NULL,
    added_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(viewer_wallet_address, token_address)
);

CREATE INDEX IF NOT EXISTS idx_user_watchlist_viewer ON user_watchlist(viewer_wallet_address);
CREATE INDEX IF NOT EXISTS idx_user_favorites_viewer ON user_favorites(viewer_wallet_address);
