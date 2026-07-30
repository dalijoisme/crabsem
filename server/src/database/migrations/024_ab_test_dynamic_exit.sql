-- 024_ab_test_dynamic_exit.sql - Decision Benchmark: adds volume-trend
-- tracking needed by the new shared Dynamic Exit rule (TP15 as a
-- minimum target, not a hard stop - see services/dynamicExitService.js).
-- "Is volume still building" requires comparing THIS cycle's volume_1h
-- against the last time this exact position was checked.

ALTER TABLE ab_test_positions ADD COLUMN last_volume_1h REAL;
