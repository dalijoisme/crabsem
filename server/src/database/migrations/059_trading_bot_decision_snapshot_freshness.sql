-- Production Hotfix V1.1, Section 3 (Observability): every BUY
-- candidate must visibly expose Market Data Age, Last Snapshot Time,
-- Decision Time, and Snapshot Source - not just silently factor into
-- the freshness gate (entryGateService.js) behind the scenes. Additive,
-- nullable - a row computed before this migration simply has none.

ALTER TABLE trading_bot_decision_snapshot ADD COLUMN market_age_seconds REAL;
ALTER TABLE trading_bot_decision_snapshot ADD COLUMN last_snapshot_at TEXT;
ALTER TABLE trading_bot_decision_snapshot ADD COLUMN decision_time TEXT;
ALTER TABLE trading_bot_decision_snapshot ADD COLUMN snapshot_source TEXT;
