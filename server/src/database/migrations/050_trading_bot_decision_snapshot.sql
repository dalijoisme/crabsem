-- 050_trading_bot_decision_snapshot.sql - Live Decision Center sprint.
-- Every cycle, tradingBotScheduler.js's computeLiveByAddressForPhilosophy
-- and tradingBotEngine.js's orderCandidates already compute a real
-- action/confidence/risk/rank for every candidate token this user's cycle
-- touched - then both go out of scope and are discarded the moment the
-- cycle returns, so the dashboard has never been able to show what CRAB
-- is currently looking at, only what it already decided (BUY/SELL log
-- rows) after the fact.
--
-- Bounded by CANDIDATE COUNT this cycle, never by the ~12,000-token scan
-- universe: services/tradingBotEngine.js's runCycle replaces this user's
-- entire snapshot every cycle (DELETE + bulk INSERT, one transaction) with
-- only every real BUY/STRONG BUY tier token (the actual "qualified
-- candidates", already gated by the frozen entry thresholds - a small
-- real set) plus a small top-N sample of HOLD-tier and AVOID-tier tokens
-- for visibility. Never one row per scanned token.
CREATE TABLE IF NOT EXISTS trading_bot_decision_snapshot (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    token_address TEXT NOT NULL,
    token_symbol TEXT,
    action TEXT NOT NULL,
    confidence REAL,
    risk TEXT,
    tier TEXT,
    rank INTEGER,
    priority_score INTEGER,
    reasons_json TEXT,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_trading_bot_decision_snapshot_user ON trading_bot_decision_snapshot(user_id);
