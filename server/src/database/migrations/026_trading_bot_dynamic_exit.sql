-- 026_trading_bot_dynamic_exit.sql - Final Specification section 08
-- (Trade Manager Design): wiring dynamicExitService.evaluateDynamicExit
-- into the real Trading Bot (tradeManager.js) requires the same
-- volume-trend tracking migration 024 already added to ab_test_positions -
-- "is volume still building" needs comparing this cycle's volume_1h
-- against the last time this exact position was checked. Implementation
-- detail required to wire in an already-approved, already-validated
-- mechanism (dynamicExitService.js) - not a new feature, not a change
-- to Production V2 or to any public API shape.

ALTER TABLE trading_bot_positions ADD COLUMN last_volume_1h REAL;
