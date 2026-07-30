-- 028_benchmark_signal_latency.sql - Benchmark Harness Architecture
-- Design Document section 7 (Report Generation): Signal Latency must be
-- computable from CLOSED trades too, not only still-open positions -
-- every position in a COMPLETED run is closed by definition. decision_at
-- already exists on benchmark_positions (migration 027); this carries it
-- through to benchmark_trades at close time so the report can compute
-- latency for the whole run, not just whatever happens to still be open.

ALTER TABLE benchmark_trades ADD COLUMN decision_at TEXT;
