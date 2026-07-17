-- Recommendation validation framework (see server/INTELLIGENCE_ENGINE.md
-- and the data-integrity audit). Purely additive: the Intelligence
-- Engine itself is untouched by these tables - this only gives it a
-- memory. Every recommendation the engine computes during a scheduler
-- tick is logged here, then automatically re-checked against real
-- price history at fixed horizons, so win rate / accuracy / precision
-- can be measured from real outcomes instead of assumed.

CREATE TABLE IF NOT EXISTS recommendation_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token_address TEXT NOT NULL,
    symbol TEXT,
    recorded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    action TEXT NOT NULL,               -- STRONG BUY | BUY | HOLD | AVOID
    stage TEXT,
    participant_score REAL,
    market_health REAL,
    confidence REAL,
    risk TEXT,
    lifecycle TEXT,                     -- ACTIVE | WATCHLIST | ARCHIVED at log time
    price_at_recommendation REAL,       -- gmgn_tokens.price at recorded_at; the
                                         -- engine has no separate "entry price"
                                         -- field (see data-integrity audit) -
                                         -- this IS the entry price convention.
    reasons_json TEXT,
    confirmations_json TEXT,
    risk_reasons_json TEXT,
    breakdown_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_recommendation_log_token ON recommendation_log(token_address);
CREATE INDEX IF NOT EXISTS idx_recommendation_log_recorded_at ON recommendation_log(recorded_at);
CREATE INDEX IF NOT EXISTS idx_recommendation_log_action ON recommendation_log(action);

-- One row per (recommendation, horizon) once that horizon has
-- elapsed and been evaluated against real price history.

CREATE TABLE IF NOT EXISTS recommendation_outcomes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    recommendation_id INTEGER NOT NULL REFERENCES recommendation_log(id),
    horizon TEXT NOT NULL,              -- '15m' | '30m' | '1h' | '4h' | '24h'
    evaluated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    price_at_horizon REAL,
    return_pct REAL,
    win INTEGER,                        -- 1/0 - see validationMetricsService for the definition applied
    UNIQUE(recommendation_id, horizon)
);

CREATE INDEX IF NOT EXISTS idx_recommendation_outcomes_horizon ON recommendation_outcomes(horizon);

-- Real per-token price time series, going forward - filled in the
-- same transaction as the existing 30s gmgn_tokens upsert (see
-- gmgnTokenRepository.upsertTokens), not by parsing the unindexed
-- gmgn_raw_snapshots blobs. This is what recommendation_outcomes is
-- evaluated against.

CREATE TABLE IF NOT EXISTS token_price_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token_address TEXT NOT NULL,
    price REAL,
    market_cap REAL,
    liquidity REAL,
    recorded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_token_price_history_token_time ON token_price_history(token_address, recorded_at);
