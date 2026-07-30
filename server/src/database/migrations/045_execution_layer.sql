-- 045_execution_layer.sql - Execution Layer foundation (Sprint 1).
-- CRAB AGENT has never executed a real trade before this migration -
-- every BUY/SELL up to now is a virtual row in trading_bot_positions/
-- trading_bot_trades (see services/tradingBotEngine.js's header
-- comment). These two tables back the NEW, separate real-execution
-- pipeline (services/execution/executionService.js) - they are never
-- read by the simulated trading bot and the simulated trading bot's
-- tables are never read by this pipeline. No existing table is
-- touched by this migration.
--
-- `executions` is CURRENT STATE (one row per attempted real
-- transaction, overwritten in place as it moves through
-- services/execution/executorStateMachine.js's states) - same split as
-- trading_bot_positions (current state) vs trading_bot_log (append-only)
-- in migration 016_trading_bot.sql. `execution_log` is the append-only
-- side of that same split, written by services/execution/executionLogger.js.
--
-- status values: IDLE, PREPARING, SIGNING, SUBMITTING, SUBMITTED,
-- CONFIRMING, SUCCESS, FAILED, TIMEOUT - see executorStateMachine.js
-- for the full legal-transition table and why SUBMITTED and TIMEOUT
-- are each their own state rather than folded into SUBMITTING/FAILED.
--
-- blockhash/last_valid_block_height are persisted at PREPARING time
-- (both already exist on any real Transaction/VersionedTransaction
-- object) so transactionConfirmationService.js can tell "still
-- pending, unknown" apart from "this blockhash can never land anymore"
-- when a poll times out.
--
-- retry_count exists as a column only - Sprint 1 never increments it
-- or loops on it (retry strategy is explicitly Sprint 2 scope).

CREATE TABLE IF NOT EXISTS executions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    wallet_public_key TEXT NOT NULL,
    token_address TEXT,
    action TEXT NOT NULL,
    amount_lamports INTEGER,
    amount_usd REAL,
    status TEXT NOT NULL DEFAULT 'IDLE',
    tx_hash TEXT,
    blockhash TEXT,
    last_valid_block_height INTEGER,
    retry_count INTEGER NOT NULL DEFAULT 0,
    error_message TEXT,
    confirmation_result_json TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_executions_user_id ON executions(user_id);
CREATE INDEX IF NOT EXISTS idx_executions_status ON executions(status);
CREATE INDEX IF NOT EXISTS idx_executions_tx_hash ON executions(tx_hash);

-- Trading wallets are 1:1 per user (migration 040) - this enforces at
-- most one non-terminal execution per user at a time, at the database
-- layer, not just in service-layer logic. A partial index (SQLite
-- supports a WHERE clause on CREATE UNIQUE INDEX) so terminal rows
-- (SUCCESS/FAILED/TIMEOUT) never conflict with each other or block a
-- later attempt.
CREATE UNIQUE INDEX IF NOT EXISTS idx_executions_one_active_per_user
    ON executions(user_id) WHERE status NOT IN ('SUCCESS', 'FAILED', 'TIMEOUT');

CREATE TABLE IF NOT EXISTS execution_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    execution_id INTEGER NOT NULL REFERENCES executions(id),
    log_type TEXT NOT NULL,        -- 'TRANSITION' | 'ERROR' | 'RPC'
    from_status TEXT,
    to_status TEXT,
    message TEXT,
    rpc_endpoint TEXT,
    latency_ms INTEGER,
    meta_json TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_execution_log_execution_id ON execution_log(execution_id);
