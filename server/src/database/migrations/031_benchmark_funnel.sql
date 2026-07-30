-- 031_benchmark_funnel.sql - Profile-Aware Production V2 refactor
-- (approved architecture: floating-sauteeing-swan.md), funnel
-- visibility requirement. Two additive tables:
--
-- benchmark_funnel_snapshots: one row per participant per tick,
-- showing exactly where candidates were lost at each stage (scanned ->
-- hard reject -> AI candidate -> AI tier passed -> entry gate opened/
-- skipped) - the funnel the architecture asked to be able to see per
-- profile.
--
-- benchmark_candidate_sightings: per-participant record of every token
-- that participant's OWN profile-scored signal marked BUY/STRONG BUY
-- this tick. Fixes a real gap this refactor would otherwise leave
-- broken: benchmarkReportService.js's hindsight metrics (Opportunity
-- Capture/False Negative/Signal Latency) used to read the ONE shared,
-- profile-blind prediction_history table (written by the live bot, on
-- its own cadence, completely unrelated to what any given benchmark
-- participant's profile actually saw) - now each profile's own
-- candidate history is tracked directly.

CREATE TABLE IF NOT EXISTS benchmark_funnel_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL REFERENCES benchmark_runs(id),
    run_participant_id INTEGER NOT NULL REFERENCES benchmark_run_participants(id),
    tokens_scanned INTEGER NOT NULL,
    hard_reject_count INTEGER,
    ai_candidates_count INTEGER,
    ai_tier_passed_count INTEGER,
    entry_gate_opened_count INTEGER NOT NULL,
    entry_gate_skipped_count INTEGER NOT NULL,
    skip_reasons_json TEXT,
    profile_aware INTEGER NOT NULL DEFAULT 1,
    taken_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_benchmark_funnel_snapshots_participant_time
    ON benchmark_funnel_snapshots(run_participant_id, taken_at);

CREATE TABLE IF NOT EXISTS benchmark_candidate_sightings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL REFERENCES benchmark_runs(id),
    run_participant_id INTEGER NOT NULL REFERENCES benchmark_run_participants(id),
    token_address TEXT NOT NULL,
    entry_price_at_first_sight REAL,
    first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(run_participant_id, token_address)
);

CREATE INDEX IF NOT EXISTS idx_benchmark_candidate_sightings_participant
    ON benchmark_candidate_sightings(run_participant_id);
