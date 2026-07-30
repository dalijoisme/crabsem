-- 052_trading_bot_candidate_sightings.sql - Momentum Validation System
-- sprint. Average Entry Delay needs "how long has CRAB been eyeing this
-- token", which the Live Decision Center's decision-snapshot table
-- (migration 050) structurally cannot answer - that table is deleted and
-- rebuilt whole every cycle by design, so no first-seen history survives
-- across cycles. Mirrors the Benchmark Harness's own already-proven
-- pattern exactly (benchmark_candidate_sightings, migration 031):
-- first_seen_at is set once (the INSERT branch of an upsert) and never
-- overwritten; last_seen_at refreshes on every re-sighting.
--
-- Known, stated limitation (same one the Benchmark Harness already has,
-- not new to this table): first_seen_at never resets, so a token sighted
-- long ago, dropped, and re-qualified today still shows its original
-- first-seen date. Real signal either way (how long CRAB has known about
-- this token, ever) - just not a per-observation-window reset. Deferred
-- to P1 if that distinction turns out to matter.

CREATE TABLE IF NOT EXISTS trading_bot_candidate_sightings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    token_address TEXT NOT NULL,
    token_symbol TEXT,
    entry_price_at_first_sight REAL,
    first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, token_address)
);
