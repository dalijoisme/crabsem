-- 027_benchmark_harness.sql - Benchmark Harness Architecture Design
-- Document (approved), sections 4/8. Adds the permanent Benchmark
-- Harness subsystem's schema. Every table here is additive and
-- isolated from trading_bot_*/ab_test_* - the harness is an observer,
-- never a participant in live trading (Constitution: must not modify
-- Production V2, Strategy Profiles, Opportunity Priority, EMI,
-- Prediction Engine, or the Collector).
--
-- benchmark_profiles: reusable, named preset DEFINITIONS - the
-- config-only extensibility point. Adding a new benchmark participant
-- (e.g. "CONFIDENCE_68", "EMI_OFF") is an INSERT into this table, never
-- a code change (architecture doc section 4/8).
CREATE TABLE IF NOT EXISTS benchmark_profiles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    description TEXT,
    config_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- benchmark_runs: one row per execution/session.
CREATE TABLE IF NOT EXISTS benchmark_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'PENDING',   -- PENDING | RUNNING | PAUSED | STOPPED | COMPLETED
    planned_duration_seconds INTEGER NOT NULL,
    total_paused_seconds INTEGER NOT NULL DEFAULT 0,
    market_data_notes TEXT,
    started_at TEXT,
    paused_at TEXT,
    stopped_at TEXT,
    completed_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_benchmark_runs_status ON benchmark_runs(status);

-- benchmark_run_participants: junction between a run and the profiles
-- selected for it. config_json is a FROZEN COPY of
-- benchmark_profiles.config_json taken at run start - editing a preset
-- later must never silently change a historical run's results
-- (architecture doc section 4/9 - reproducibility requirement).
CREATE TABLE IF NOT EXISTS benchmark_run_participants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL REFERENCES benchmark_runs(id),
    profile_id INTEGER NOT NULL REFERENCES benchmark_profiles(id),
    frozen_config_json TEXT NOT NULL,
    initial_capital REAL NOT NULL,
    joined_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(run_id, profile_id)
);

CREATE INDEX IF NOT EXISTS idx_benchmark_run_participants_run ON benchmark_run_participants(run_id);

-- benchmark_positions / benchmark_trades: isolated per (run_id,
-- run_participant_id) - same shape as trading_bot_positions/
-- trading_bot_trades (proven schema), scoped so no two participants,
-- even in the same run, ever share a row.
CREATE TABLE IF NOT EXISTS benchmark_positions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL REFERENCES benchmark_runs(id),
    run_participant_id INTEGER NOT NULL REFERENCES benchmark_run_participants(id),
    token_address TEXT NOT NULL,
    token_symbol TEXT,
    entry_price REAL NOT NULL,
    current_price REAL,
    size_usd REAL NOT NULL,
    confidence REAL,
    exit_strategy TEXT,
    engine_version TEXT,
    target_price REAL,
    target_market_cap REAL,
    stop_loss_price REAL,
    stop_loss_market_cap REAL,
    last_volume_1h REAL,
    mfe_pct REAL DEFAULT 0,
    mae_pct REAL DEFAULT 0,
    decision_at TEXT,          -- token_last_decision.last_decision_at at entry - Signal Latency source (report section 7)
    status TEXT NOT NULL DEFAULT 'OPEN',   -- OPEN | CLOSED
    opened_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    closed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_benchmark_positions_participant_status ON benchmark_positions(run_participant_id, status);
CREATE INDEX IF NOT EXISTS idx_benchmark_positions_run_token ON benchmark_positions(run_id, token_address);

CREATE TABLE IF NOT EXISTS benchmark_trades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL REFERENCES benchmark_runs(id),
    run_participant_id INTEGER NOT NULL REFERENCES benchmark_run_participants(id),
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
    opened_at TEXT,
    closed_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_benchmark_trades_participant ON benchmark_trades(run_participant_id);
CREATE INDEX IF NOT EXISTS idx_benchmark_trades_run ON benchmark_trades(run_id, closed_at);

-- benchmark_statistics: periodic time-series snapshot - powers the
-- live equity curve and the real (not estimated) max-drawdown
-- calculation, same convention as ab_test_equity_snapshot.
CREATE TABLE IF NOT EXISTS benchmark_statistics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL REFERENCES benchmark_runs(id),
    run_participant_id INTEGER NOT NULL REFERENCES benchmark_run_participants(id),
    equity REAL NOT NULL,
    available_cash REAL NOT NULL,
    open_position_count INTEGER NOT NULL DEFAULT 0,
    taken_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_benchmark_statistics_participant_time ON benchmark_statistics(run_participant_id, taken_at);

-- benchmark_reports: final, frozen output - generated once per
-- completed run per participant (or on-demand for a "standings so
-- far" preview). metrics_json is a JSON blob so new metrics never
-- require a migration (same pattern as reason_json/meta_json
-- elsewhere in this codebase).
CREATE TABLE IF NOT EXISTS benchmark_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL REFERENCES benchmark_runs(id),
    run_participant_id INTEGER NOT NULL REFERENCES benchmark_run_participants(id),
    generated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    is_final INTEGER NOT NULL DEFAULT 0,
    rank INTEGER,
    metrics_json TEXT NOT NULL,
    UNIQUE(run_id, run_participant_id)
);

CREATE INDEX IF NOT EXISTS idx_benchmark_reports_run ON benchmark_reports(run_id);

-- Seed the 4 initial benchmark participants named in the architecture
-- doc's smoke test (Baseline/Stable/Balanced/Aggressive) as DATA, not
-- code - proving the "add a participant through configuration only"
-- requirement from the very first migration. STABLE/BALANCED/AGGRESSIVE
-- values are copied verbatim from config/strategyProfileConfig.js;
-- BASELINE uses the original pre-Constitution defaults (migrations
-- 016/021) with both new layers off.
INSERT OR IGNORE INTO benchmark_profiles (name, description, config_json) VALUES
('BASELINE', 'Production V2 with no Strategy Profile layer - original pre-Constitution defaults, Opportunity Priority and EMI both off.',
 '{"min_confidence":60,"min_decay_fraction":0.90,"position_size_pct":20,"max_position_size":100,"max_open_positions":5,"cooldown_win_minutes":5,"cooldown_loss_minutes":30,"cooldown_reversal_minutes":15,"cooldown_default_minutes":10,"opportunity_priority_enabled":0,"emi_enabled":0,"exit_strategy_variant":"dynamicExit","initial_capital":100}'),
('STABLE', 'Constitution v1.0 Stable profile - profit stabil, drawdown minimal.',
 '{"min_confidence":65,"min_decay_fraction":0.90,"position_size_pct":10,"max_position_size":100,"max_open_positions":5,"cooldown_win_minutes":10,"cooldown_loss_minutes":45,"cooldown_reversal_minutes":20,"cooldown_default_minutes":15,"opportunity_priority_enabled":0,"emi_enabled":0,"exit_strategy_variant":"dynamicExit","initial_capital":100}'),
('BALANCED', 'Constitution v1.0 Balanced profile - Opportunity Priority on, EMI off.',
 '{"min_confidence":60,"min_decay_fraction":0.90,"position_size_pct":15,"max_position_size":150,"max_open_positions":7,"cooldown_win_minutes":7,"cooldown_loss_minutes":30,"cooldown_reversal_minutes":15,"cooldown_default_minutes":10,"opportunity_priority_enabled":1,"emi_enabled":0,"exit_strategy_variant":"dynamicExit","initial_capital":100}'),
('AGGRESSIVE', 'Constitution v1.0 Aggressive profile - Opportunity Priority and EMI both on.',
 '{"min_confidence":45,"min_decay_fraction":0.85,"position_size_pct":15,"max_position_size":150,"max_open_positions":10,"cooldown_win_minutes":5,"cooldown_loss_minutes":20,"cooldown_reversal_minutes":10,"cooldown_default_minutes":7,"opportunity_priority_enabled":1,"emi_enabled":1,"exit_strategy_variant":"dynamicExit","initial_capital":100}');
