-- AI Validation Framework (engine-quality sprint 3). This is
-- DELIBERATELY a new, separate table from recommendation_log/
-- recommendation_outcomes (Sprint 2's validation framework, still
-- intact and untouched) - that one logs a fresh snapshot every 5
-- minutes for every tracked token and re-derives outcomes at fixed
-- horizons; it was never designed to answer "was THIS token's FIRST
-- ever actionable recommendation right, end to end, with a real
-- TP/SL outcome". prediction_history exists specifically for that:
-- one IMMUTABLE row per token, created the first time it produces a
-- real, evidence-backed trade plan (see predictionValidationService.
-- js), never overwritten even if the recommendation later changes.
--
-- Column groups are split deliberately:
--   - ENTRY/IMMUTABLE columns are written ONCE at INSERT time and
--     never touched again by any UPDATE statement in this codebase
--     (enforced at the repository layer - updateTracking() only ever
--     lists the TRACKING columns below).
--   - TRACKING columns are the only ones the per-minute validation
--     scheduler ever updates, as real market data arrives.

CREATE TABLE IF NOT EXISTS prediction_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,

    -- ---- ENTRY / IMMUTABLE (written once, never updated) ----
    token_address TEXT NOT NULL,
    token_symbol TEXT,

    prediction_time TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    recommendation TEXT NOT NULL,        -- STRONG BUY | BUY | HOLD | AVOID at prediction time
    score REAL,                          -- participantScore at prediction time
    confidence REAL,
    reason_json TEXT,                    -- signal.reasons at prediction time

    entry_price REAL,
    entry_market_cap REAL,
    entry_liquidity REAL,
    entry_volume REAL,                   -- volume_1h at prediction time
    entry_holders INTEGER,               -- real holder count at prediction time - not in the
                                          -- literal spec list, but required for a REAL (not
                                          -- fabricated) "Holder Decline" failure-analysis category

    wallet_summary_json TEXT,
    trade_plan_json TEXT,                -- full riskBands snapshot at prediction time

    target_price REAL,
    target_market_cap REAL,
    stop_loss_price REAL,
    stop_loss_market_cap REAL,

    prediction_horizon_seconds INTEGER NOT NULL,

    -- ---- STATUS + TRACKING (the only columns any UPDATE touches) ----
    status TEXT NOT NULL DEFAULT 'OPEN', -- OPEN | TP_HIT | SL_HIT | EXPIRED

    current_price REAL,
    current_market_cap REAL,
    current_roi_pct REAL,

    mfe_pct REAL,                        -- Maximum Favorable Excursion (best ROI ever observed)
    mae_pct REAL,                        -- Maximum Adverse Excursion (worst ROI ever observed)

    time_alive_seconds INTEGER,

    closed_at TEXT,
    close_reason TEXT,                   -- failure-analysis category, only set when status != TP_HIT

    last_checked_at TEXT,

    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    -- One immutable "first recommendation" prediction per token, ever -
    -- this IS the "do not overwrite" guarantee, enforced by the
    -- database itself, not just application discipline.
    UNIQUE(token_address)
);

CREATE INDEX IF NOT EXISTS idx_prediction_history_status ON prediction_history(status);
CREATE INDEX IF NOT EXISTS idx_prediction_history_recommendation ON prediction_history(recommendation);
CREATE INDEX IF NOT EXISTS idx_prediction_history_prediction_time ON prediction_history(prediction_time);

-- Prediction Timeline (Part 8) - the real learning dataset. One row
-- per (prediction, horizon) once that horizon has actually elapsed,
-- using the same real-price-history-lookup convention
-- outcomeEvaluatorService.js already established (never a live
-- "whatever the price happens to be when the scheduler gets to it" -
-- the real recorded price at/after the exact horizon boundary).

CREATE TABLE IF NOT EXISTS prediction_timeline (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    prediction_id INTEGER NOT NULL REFERENCES prediction_history(id),
    horizon TEXT NOT NULL,               -- '30m' | '1h' | '2h' | '4h' | '8h' | '24h'
    recorded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    roi_pct REAL,
    market_cap REAL,
    price REAL,
    UNIQUE(prediction_id, horizon)
);

CREATE INDEX IF NOT EXISTS idx_prediction_timeline_prediction ON prediction_timeline(prediction_id);
