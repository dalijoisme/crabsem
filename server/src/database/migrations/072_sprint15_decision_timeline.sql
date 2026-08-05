-- 072_sprint15_decision_timeline.sql - Sprint 15 (Scientific Decision
-- Framework), Phase 5 (Decision Timeline / "flight recorder"). Post-
-- entry market evolution for an open position, sampled at a decaying
-- cadence piggybacked on the existing exit-management tick
-- (manageOpenPositions, shared by scheduler/exitEvaluationScheduler.js
-- and tradingBotScheduler.js - see decisionTimelineService.js's own
-- header) - never a new, independent poll.
--
-- Narrow, real columns (not a JSON blob) - matches
-- repositories/tokenPriceHistoryRepository.js's own time-series shape,
-- not decision_evidence's wide JSON-tier shape, because the query
-- pattern here is "plot X over time for one decision", which benefits
-- from columnar access the same way token_price_history already does.
--
-- Append-only, same as decision_evidence and for the same reason - see
-- repositories/decisionTimelineRepository.js's own header. A position's
-- lifetime is naturally bounded (TP/SL/time-exit closes it), so this
-- table's growth is bounded per-decision regardless of hold duration -
-- see decisionTimelineService.js's decaying-cadence policy.

CREATE TABLE IF NOT EXISTS decision_timeline_samples (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    decision_evidence_id INTEGER NOT NULL REFERENCES decision_evidence(id),
    token_address TEXT NOT NULL,
    sample_time TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    price REAL,
    liquidity REAL,
    holders INTEGER,
    -- concentration of GMGN-tagged smart/degen wallets among holders -
    -- the same real gmgn_trenches.smart_degen_count field
    -- participant/whale.js already reads, already a promoted column, no
    -- extra parse needed.
    smart_degen_count INTEGER,
    -- from trenches.raw_json, same real fields
    -- syntheticMarketFilterService.js already reads for the BUY-time veto
    -- - reused via its own computeSyntheticBreakdown, never a second
    -- implementation.
    bundler_trader_amount_rate REAL,
    fresh_wallet_rate REAL,
    synthetic_score REAL,
    momentum_phase TEXT,

    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_decision_timeline_decision ON decision_timeline_samples(decision_evidence_id);
CREATE INDEX IF NOT EXISTS idx_decision_timeline_token ON decision_timeline_samples(token_address);
