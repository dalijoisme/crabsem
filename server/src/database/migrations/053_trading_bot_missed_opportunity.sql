-- 053_trading_bot_missed_opportunity.sql - Momentum Validation System
-- sprint. This sprint's own stated top priority: a real history of
-- "token was seen, genuinely rejected by the (frozen, unchanged)
-- entry gate, and later did X" - never a guessed reason, never a
-- fabricated outcome.
--
-- The partial unique index bounds this table to exactly one PENDING row
-- per (user, token): a token rejected every cycle for hours refreshes
-- the same row (rank_at_skip/reason/price_at_skip updated to the latest
-- rejection) instead of inserting one row per cycle, which would
-- otherwise grow unbounded (thousands of rows/day for a single
-- recurring rejection). Same proven partial-unique-index shape already
-- used for "at most one active row" in migration 045's
-- idx_executions_one_active_per_user. Once outcome_evaluated_at is set
-- (by the new missedOpportunityOutcomeScheduler.js), a later fresh
-- rejection of the same token correctly opens a new row - a genuinely
-- separate missed-opportunity event.
--
-- outcome_price/outcome_return_pct/outcome_evaluated_at are filled going
-- forward only, from token_price_history (already-collected real time
-- series, migration 006) - never new GMGN polling, never guessed.

CREATE TABLE IF NOT EXISTS trading_bot_missed_opportunity (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    token_address TEXT NOT NULL,
    token_symbol TEXT,
    rank_at_skip INTEGER,
    priority_score_at_skip INTEGER,
    reason TEXT NOT NULL,
    price_at_skip REAL,
    skipped_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    outcome_price REAL,
    outcome_return_pct REAL,
    outcome_evaluated_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_missed_opportunity_pending
    ON trading_bot_missed_opportunity(user_id, token_address) WHERE outcome_evaluated_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_missed_opportunity_user_skipped_at
    ON trading_bot_missed_opportunity(user_id, skipped_at);
