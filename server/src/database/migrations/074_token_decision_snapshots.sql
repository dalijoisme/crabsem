-- Decision-timing instrumentation (2026-08-07, exit/entry engine
-- optimization mission, Phase 5): every prior confidence/participant/
-- market signal only ever survived at a single point in time -
-- token_last_decision is overwritten in place every cycle (no history),
-- and trading_bot_trades only captures the snapshot AT the moment of
-- BUY. Neither can answer "how did this token's confidence/participant
-- score/momentum phase evolve in the minutes BEFORE we bought it (or
-- passed on it)" - exactly the gap the user asked to close.
--
-- realtime_pulse_snapshots (migration 068) already provides a genuine,
-- densely-populated time series for the raw market/flow side (holders,
-- liquidity, volume_1h, buys_5m/sells_5m, smart-money/KOL USD flow) - not
-- duplicated here. This table covers what that one does NOT: the
-- DECISION-side signals (confidence and its components, participant/
-- market module scores, momentum phase classification) at the same
-- cadence, joinable to realtime_pulse_snapshots by (token_address,
-- recorded_at) for a full picture.
--
-- Written from services/predictionValidationService.js's
-- evaluateAndRecordDecisions() - the SAME per-cycle loop that already
-- writes token_last_decision (tradingBotEngine.js's own single source of
-- truth for real BUY decisions - see that file's own header), so this
-- captures the real decision pipeline, not a shadow/parallel one.
-- Gated to skip AVOID-tier tokens there to bound table growth to
-- genuinely-interesting candidates (BUY/STRONG BUY/HOLD), not the full
-- multi-thousand-token scan firehose.
CREATE TABLE token_decision_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token_address TEXT NOT NULL,
    recorded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    recommendation TEXT,
    confidence REAL,
    base_confidence REAL,
    participant_score REAL,
    market_health REAL,
    risk TEXT,
    momentum_phase TEXT,
    -- Same shape as trading_bot_trades.module_scores_json (participant +
    -- market per-module {score,max,hasData}) - one consistent JSON shape
    -- across the codebase for "all module scores at a point in time"
    -- rather than dozens of individual columns that would need a new
    -- migration every time a module is added/removed.
    module_scores_json TEXT
);

-- Every real read pattern is "this token's history, ordered by time" -
-- same index shape token_price_history/realtime_pulse_snapshots already
-- use.
CREATE INDEX idx_token_decision_snapshots_token_time ON token_decision_snapshots(token_address, recorded_at);
