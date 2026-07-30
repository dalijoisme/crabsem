-- 035_trading_bot_multitenant.sql - Sprint A, Goal 2 (auth/multi-tenancy
-- foundation). Migrates the trading bot domain from a single global
-- singleton (id CHECK(id=1)) to real per-user rows. No REQUIRES_FK_OFF
-- marker needed - confirmed via grep that nothing holds a foreign key
-- REFERENCES into trading_bot_state or trading_bot_config, so a plain
-- drop+recreate inside the normal transaction-wrapped migration is safe
-- (contrast with 017_prediction_pipeline_redesign.sql, which needed that
-- marker because prediction_timeline DOES reference prediction_history).
--
-- trading_bot_state/config are pure CURRENT-SETTINGS tables (not an
-- append-only history), and the CTO decided legacy singleton data must
-- never be attached to any real user's equity/profit history (Sprint A
-- Goal 1 requires a clean start per user) - so these two are rebuilt
-- EMPTY, not backfilled from today's one dev/test row.
--
-- trading_bot_positions/trades/log/equity_snapshot ARE real historical
-- records (an audit trail), so those keep every existing row - each
-- just gains a nullable user_id column. Existing rows get user_id=NULL
-- (archived/orphaned per the CTO's decision: available for debugging/
-- research, never surfaced to any real user account - every
-- tradingBotRepository query going forward filters WHERE user_id = ?,
-- which a NULL user_id can never match).

DROP TABLE trading_bot_state;

CREATE TABLE trading_bot_state (
    user_id INTEGER PRIMARY KEY REFERENCES users(id),
    status TEXT NOT NULL DEFAULT 'STOPPED',           -- STOPPED | RUNNING | PAUSED
    mode TEXT NOT NULL DEFAULT 'SIMULATION',           -- LIVE | SIMULATION
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_action TEXT,
    last_action_at TEXT,
    -- Set on the STOPPED/PAUSED -> RUNNING transition, cleared on STOP.
    -- last_action_at resets on every pause/resume, so it can't answer
    -- "how long has this user's profit-proof actually been running" -
    -- this column can (Sprint A Goal 1's own equity-curve endpoint,
    -- see routes/v1/tradingBot.js's GET /equity-curve).
    running_since TEXT
);

DROP TABLE trading_bot_config;

CREATE TABLE trading_bot_config (
    user_id INTEGER PRIMARY KEY REFERENCES users(id),
    initial_capital REAL NOT NULL DEFAULT 100,
    position_size_pct REAL NOT NULL DEFAULT 20,
    max_position_size REAL NOT NULL DEFAULT 100,
    max_open_positions INTEGER NOT NULL DEFAULT 5,
    min_order_size REAL NOT NULL DEFAULT 10,
    fee_pct REAL NOT NULL DEFAULT 1,
    slippage_pct REAL NOT NULL DEFAULT 1,
    one_position_per_token INTEGER NOT NULL DEFAULT 1,
    scan_interval_seconds INTEGER NOT NULL DEFAULT 60,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    min_confidence REAL NOT NULL DEFAULT 60,
    min_decay_fraction REAL NOT NULL DEFAULT 0.90,
    cooldown_win_minutes INTEGER NOT NULL DEFAULT 5,
    cooldown_loss_minutes INTEGER NOT NULL DEFAULT 30,
    cooldown_reversal_minutes INTEGER NOT NULL DEFAULT 15,
    cooldown_default_minutes INTEGER NOT NULL DEFAULT 10,
    execution_mode TEXT NOT NULL DEFAULT 'REGULAR',
    strategy_profile TEXT NOT NULL DEFAULT 'STABLE',
    opportunity_priority_enabled INTEGER NOT NULL DEFAULT 0,
    emi_enabled INTEGER NOT NULL DEFAULT 0,
    weights_json TEXT,
    tiers_json TEXT,
    min_liquidity_usd REAL,
    min_volume_usd REAL,
    flatten_earliness INTEGER NOT NULL DEFAULT 1,
    sm_bonus INTEGER NOT NULL DEFAULT 0,
    quality_gate_overrides_json TEXT,
    fixed_tp_pct REAL NOT NULL DEFAULT 15,
    stop_loss_overrides_json TEXT,
    momentum_weakening_buyer_dominance_ratio REAL NOT NULL DEFAULT 0.5,
    acceleration_overrides_json TEXT
);

ALTER TABLE trading_bot_positions ADD COLUMN user_id INTEGER REFERENCES users(id);
ALTER TABLE trading_bot_trades ADD COLUMN user_id INTEGER REFERENCES users(id);
ALTER TABLE trading_bot_log ADD COLUMN user_id INTEGER REFERENCES users(id);
ALTER TABLE trading_bot_equity_snapshot ADD COLUMN user_id INTEGER REFERENCES users(id);

CREATE INDEX IF NOT EXISTS idx_trading_bot_positions_user_status ON trading_bot_positions(user_id, status);
CREATE INDEX IF NOT EXISTS idx_trading_bot_positions_user_token ON trading_bot_positions(user_id, token_address);
CREATE INDEX IF NOT EXISTS idx_trading_bot_trades_user_closed_at ON trading_bot_trades(user_id, closed_at);
CREATE INDEX IF NOT EXISTS idx_trading_bot_trades_user_token ON trading_bot_trades(user_id, token_address, closed_at);
CREATE INDEX IF NOT EXISTS idx_trading_bot_log_user_created_at ON trading_bot_log(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_trading_bot_equity_user_taken_at ON trading_bot_equity_snapshot(user_id, taken_at);
