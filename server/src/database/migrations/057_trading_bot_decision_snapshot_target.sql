-- Production Stabilization V1, Section H (Candidate Card): the
-- dashboard's condensed candidate card needs a real Target price for
-- BUY/WATCH-tier candidates, not just already-bought positions. Reuses
-- tradePlanService.buildRiskBands (the exact same, already-proven
-- function tradeManager.js's own openPosition() calls at real BUY time)
-- against the candidate's own already-computed signal - a real "if
-- bought right now" projection, never a fabricated number. Additive,
-- nullable - a row computed before this migration (or a HOLD/AVOID row,
-- which never gets a target) simply has none.

ALTER TABLE trading_bot_decision_snapshot ADD COLUMN target_price REAL;
