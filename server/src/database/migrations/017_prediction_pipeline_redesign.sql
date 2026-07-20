-- REQUIRES_FK_OFF - this migration rebuilds prediction_history (drop +
-- recreate) while prediction_timeline holds a real FK REFERENCES on it;
-- see database/migrate.js's special-cased runner for why this marker
-- is required (PRAGMA foreign_keys=OFF must be toggled outside any
-- transaction per SQLite's own documentation).
--
-- 017_prediction_pipeline_redesign.sql - splits prediction_history's two
-- conflated roles (decision log + position tracker) into two tables, per
-- the approved architecture proposal. Runs atomically inside migrate.js's
-- db.transaction() wrapper - either every step below succeeds, or none do.
--
-- NOTHING historical is destroyed: every existing prediction_history row
-- (id, every column) is preserved exactly, and additionally backfilled
-- 1:1 into the new trade_positions table so historical Win Rate/Profit
-- Factor/MFE/MAE calculations produce IDENTICAL numbers whether read from
-- the old table or the new one.

-- =====================================
-- STEP 1: trade_positions - real position lifecycle, split out of
-- prediction_history. Only one OPEN row per token, ever, enforced by a
-- partial unique index (the actual database-level guarantee the old
-- UNIQUE(token_address) used to provide, now scoped correctly to
-- positions instead of decisions).
-- =====================================

CREATE TABLE trade_positions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token_address TEXT NOT NULL,
    token_symbol TEXT,
    opened_by_prediction_id INTEGER NOT NULL REFERENCES prediction_history(id),

    entry_price REAL,
    entry_market_cap REAL,
    entry_liquidity REAL,
    entry_volume REAL,
    entry_holders INTEGER,

    target_price REAL,
    target_market_cap REAL,
    stop_loss_price REAL,
    stop_loss_market_cap REAL,
    prediction_horizon_seconds INTEGER,

    status TEXT NOT NULL DEFAULT 'OPEN',   -- OPEN | TP_HIT | SL_HIT | EXPIRED | SIGNAL_REVERSED

    current_price REAL,
    current_market_cap REAL,
    current_roi_pct REAL,
    mfe_pct REAL DEFAULT 0,
    mae_pct REAL DEFAULT 0,
    time_alive_seconds INTEGER,

    opened_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    closed_at TEXT,
    close_reason TEXT,
    last_checked_at TEXT
);

CREATE UNIQUE INDEX idx_trade_positions_one_open_per_token
    ON trade_positions(token_address) WHERE status = 'OPEN';

CREATE INDEX idx_trade_positions_status ON trade_positions(status);
CREATE INDEX idx_trade_positions_token ON trade_positions(token_address);

-- Backfill: every existing prediction_history row today IS a de facto
-- position (created under the old one-row-per-token regime) - copy its
-- position-relevant fields across exactly, linked back to the decision
-- row that created it.
INSERT INTO trade_positions (
    token_address, token_symbol, opened_by_prediction_id,
    entry_price, entry_market_cap, entry_liquidity, entry_volume, entry_holders,
    target_price, target_market_cap, stop_loss_price, stop_loss_market_cap, prediction_horizon_seconds,
    status, current_price, current_market_cap, current_roi_pct, mfe_pct, mae_pct, time_alive_seconds,
    opened_at, closed_at, close_reason, last_checked_at
)
SELECT
    token_address, token_symbol, id,
    entry_price, entry_market_cap, entry_liquidity, entry_volume, entry_holders,
    target_price, target_market_cap, stop_loss_price, stop_loss_market_cap, prediction_horizon_seconds,
    status, current_price, current_market_cap, current_roi_pct, mfe_pct, mae_pct, time_alive_seconds,
    prediction_time, closed_at, close_reason, last_checked_at
FROM prediction_history;

-- =====================================
-- STEP 2: rebuild prediction_history WITHOUT UNIQUE(token_address) -
-- SQLite has no DROP CONSTRAINT, so this uses the standard
-- create-new/copy/drop-old/rename procedure. Every column, every id,
-- every value is preserved exactly - only the constraint and 3 new
-- columns change.
-- =====================================

CREATE TABLE prediction_history_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,

    token_address TEXT NOT NULL,
    token_symbol TEXT,

    prediction_time TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    recommendation TEXT NOT NULL,
    score REAL,
    confidence REAL,
    reason_json TEXT,

    entry_price REAL,
    entry_market_cap REAL,
    entry_liquidity REAL,
    entry_volume REAL,
    entry_holders INTEGER,

    wallet_summary_json TEXT,
    trade_plan_json TEXT,

    target_price REAL,
    target_market_cap REAL,
    stop_loss_price REAL,
    stop_loss_market_cap REAL,

    prediction_horizon_seconds INTEGER NOT NULL,

    -- Tracking columns kept for backward compatibility - mirrored from
    -- trade_positions by the new service layer ONLY when this decision
    -- row is also the one that opened a position. Decision-only rows
    -- (no position opened) get status='DECISION_ONLY' so old queries
    -- filtering status='OPEN' for position-style logic never mistake a
    -- pure decision-log entry for a real open position.
    status TEXT NOT NULL DEFAULT 'DECISION_ONLY',

    current_price REAL,
    current_market_cap REAL,
    current_roi_pct REAL,

    mfe_pct REAL,
    mae_pct REAL,

    time_alive_seconds INTEGER,

    closed_at TEXT,
    close_reason TEXT,

    last_checked_at TEXT,

    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    engine_version TEXT,
    engine_name TEXT,
    exit_strategy TEXT,

    -- NEW: decision-log-specific columns
    trigger_reason TEXT,               -- which of the 10 trigger rules fired
    changed_from_recommendation TEXT,  -- prior recommendation, if any (NULL for a token's first-ever decision)
    changed_from_confidence REAL       -- prior confidence, if any

    -- NOTE: UNIQUE(token_address) intentionally removed. This is the
    -- entire point of this migration.
);

INSERT INTO prediction_history_new (
    id, token_address, token_symbol, prediction_time, recommendation, score, confidence, reason_json,
    entry_price, entry_market_cap, entry_liquidity, entry_volume, entry_holders,
    wallet_summary_json, trade_plan_json,
    target_price, target_market_cap, stop_loss_price, stop_loss_market_cap,
    prediction_horizon_seconds,
    status, current_price, current_market_cap, current_roi_pct, mfe_pct, mae_pct, time_alive_seconds,
    closed_at, close_reason, last_checked_at, created_at,
    engine_version, engine_name, exit_strategy,
    trigger_reason, changed_from_recommendation, changed_from_confidence
)
SELECT
    id, token_address, token_symbol, prediction_time, recommendation, score, confidence, reason_json,
    entry_price, entry_market_cap, entry_liquidity, entry_volume, entry_holders,
    wallet_summary_json, trade_plan_json,
    target_price, target_market_cap, stop_loss_price, stop_loss_market_cap,
    prediction_horizon_seconds,
    status, current_price, current_market_cap, current_roi_pct, mfe_pct, mae_pct, time_alive_seconds,
    closed_at, close_reason, last_checked_at, created_at,
    engine_version, engine_name, exit_strategy,
    'LEGACY_ONE_ROW_PER_TOKEN', NULL, NULL
FROM prediction_history;

DROP TABLE prediction_history;
ALTER TABLE prediction_history_new RENAME TO prediction_history;

CREATE INDEX idx_prediction_history_status ON prediction_history(status);
CREATE INDEX idx_prediction_history_recommendation ON prediction_history(recommendation);
CREATE INDEX idx_prediction_history_prediction_time ON prediction_history(prediction_time);
CREATE INDEX idx_prediction_history_engine_version ON prediction_history(engine_version);
CREATE INDEX idx_prediction_history_token_time ON prediction_history(token_address, prediction_time);

-- =====================================
-- STEP 3: token_last_decision - O(1) "what did we last decide for this
-- token" lookup, so the trigger-rule engine never needs to scan/
-- aggregate the (now fast-growing) decision log to find the comparison
-- point for change-detection.
-- =====================================

CREATE TABLE token_last_decision (
    token_address TEXT PRIMARY KEY,
    last_prediction_id INTEGER NOT NULL,
    last_recommendation TEXT NOT NULL,
    last_confidence REAL,
    last_participant_score REAL,
    last_market_health REAL,
    last_liquidity REAL,
    last_market_cap REAL,
    last_volume_1h REAL,
    last_smart_money_score REAL,
    last_whale_score REAL,
    last_decision_at TEXT NOT NULL
);

-- Seed from the current (post-migration) prediction_history so every
-- existing token already has a real baseline to compare against on its
-- very next scan, instead of being treated as brand new.
INSERT INTO token_last_decision (
    token_address, last_prediction_id, last_recommendation, last_confidence,
    last_participant_score, last_market_health, last_liquidity, last_market_cap, last_volume_1h,
    last_smart_money_score, last_whale_score, last_decision_at
)
SELECT
    token_address, id, recommendation, confidence,
    score, NULL, entry_liquidity, entry_market_cap, entry_volume,
    NULL, NULL, prediction_time
FROM prediction_history;
