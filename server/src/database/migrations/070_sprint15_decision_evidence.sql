-- 070_sprint15_decision_evidence.sql - Sprint 15 (Scientific Decision
-- Framework), Phase 3/4. Two new, permanently append-only tables:
-- decision_evidence (one row per real BUY - the frozen evidence and
-- derived scoring behind it, plus its own real Top-N ranked alternatives
-- that same cycle) and decision_evidence_config_snapshots (deduplicated,
-- permanent store of the resolved scoring config actually in effect,
-- referenced by hash rather than duplicated inline per decision).
--
-- NEVER UPDATE, NEVER DELETE either table from any code path -
-- repositories/decisionEvidenceRepository.js deliberately exposes no
-- update/delete function for either. This is a point-in-time photograph
-- of a real decision, not current state - the same distinction that
-- makes gmgn_trenches (correctly upserted) a different kind of table
-- from this one.

CREATE TABLE IF NOT EXISTS decision_evidence_config_snapshots (
    config_hash TEXT PRIMARY KEY,
    config_json TEXT NOT NULL,
    first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS decision_evidence (
    id INTEGER PRIMARY KEY AUTOINCREMENT,

    -- decision identity
    token_address TEXT NOT NULL,
    token_symbol TEXT,
    -- ON DELETE SET NULL, deliberately: decision_evidence is a permanent
    -- historical record (see this file's own header on immutability) - it
    -- must never be the reason a user deletion fails, and it must never
    -- require every present/future caller that deletes a user to
    -- remember to also clean up decision_evidence rows (a real, proven
    -- footgun - the Sprint 15 test suite hit exactly this failure mode
    -- during development, once, and this is the fix rather than patching
    -- every test's own cleanup list). A user's real historical decisions
    -- outlive the user_id pointer to them.
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    decision_time TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    engine_version TEXT,
    strategy_profile TEXT,
    -- REAL_BUY (this phase's only real writer) | SHADOW_LEAGUE |
    -- REPLAY_BACKTEST - see Sprint 15 architecture notes on unifying
    -- Engine League and Replay onto this one schema. Only REAL_BUY rows
    -- may ever carry a non-null linked_trade_id.
    origin TEXT NOT NULL DEFAULT 'REAL_BUY',

    -- winner's own derived-tier headline fields, as real columns for
    -- filtering/sorting - the full breakdown lives in derived_tier_json,
    -- these are never a second source of truth for it.
    action TEXT,
    confidence REAL,
    risk TEXT,
    participant_score REAL,
    market_health REAL,

    -- schema/version identity, so an older record stays honestly
    -- interpretable against the shape it was actually captured under,
    -- never silently re-read against whatever today's rules are.
    decision_evidence_schema_version INTEGER NOT NULL,
    context_schema_version INTEGER,

    -- Foundation tier: verbatim raw payloads. Sprint 15 Phase 3 scope:
    -- the real token row and real trenches row at decision time. Real,
    -- documented, deliberate gap (see contextContract.js's
    -- PLANNED_CONTEXT_ADDITIONS and the Phase 3 self-review): activity
    -- feed rows/wallet stats/cache bodies/peak price/liquidity-at-window-
    -- start/realtime pulse are not yet captured verbatim here - they are
    -- consumed upstream inside analyzeTokenWithPhilosophy and not yet
    -- surfaced this far down the call chain.
    foundation_tier_json TEXT,

    -- Derived tier: every module's real score/reasons, the unified entry
    -- score breakdown, confidence breakdown, entry gate trace, quality
    -- gate result - see decisionEvidenceService.js's own header for the
    -- exact shape.
    derived_tier_json TEXT,

    -- Config actually in effect for this exact decision. config_hash
    -- references decision_evidence_config_snapshots (the shared, global
    -- scoring config - deduplicated, never repeated inline).
    -- per_user_config_json is this exact user's own trading_bot_config
    -- row at decision time (genuinely per-user, not worth deduplicating
    -- the way the shared global config is).
    config_hash TEXT REFERENCES decision_evidence_config_snapshots(config_hash),
    per_user_config_json TEXT,

    trade_plan_json TEXT,

    -- Phase 4 (Candidate Snapshot). The winner needs no separate storage
    -- here - this row already IS its own foundation+derived tier. This
    -- column holds ONLY the other real ranked BUY-tier candidates this
    -- exact cycle (capped at decisionEvidenceService.js's
    -- CANDIDATE_SNAPSHOT_TOP_N), each at derived-tier depth only - see
    -- the Sprint 15 architecture review's own validated cost/value
    -- tradeoff for why non-winners are derived-tier-only.
    candidate_snapshot_json TEXT,

    linked_position_id INTEGER,
    linked_trade_id INTEGER,

    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_decision_evidence_token ON decision_evidence(token_address);
CREATE INDEX IF NOT EXISTS idx_decision_evidence_user ON decision_evidence(user_id);
CREATE INDEX IF NOT EXISTS idx_decision_evidence_time ON decision_evidence(decision_time);
CREATE INDEX IF NOT EXISTS idx_decision_evidence_position ON decision_evidence(linked_position_id);
CREATE INDEX IF NOT EXISTS idx_decision_evidence_origin ON decision_evidence(origin);
