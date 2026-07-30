// repositories/benchmarkCandidateSightingsRepository.js - Profile-Aware
// Production V2 refactor. Per-participant record of every token that
// participant's OWN profile-scored signal marked BUY/STRONG BUY at
// least once during the run - replaces benchmarkReportService.js's old
// reliance on the single shared, profile-blind prediction_history
// table for hindsight metrics (Opportunity Capture/False Negative/
// Signal Latency), which structurally could not represent what a
// specific profile actually saw as a candidate.

const db = require("../database/connection");

const upsertSightingStmt = db.prepare(`
    INSERT INTO benchmark_candidate_sightings (run_id, run_participant_id, token_address, entry_price_at_first_sight, first_seen_at, last_seen_at)
    VALUES (@runId, @runParticipantId, @tokenAddress, @entryPrice, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(run_participant_id, token_address) DO UPDATE SET last_seen_at = CURRENT_TIMESTAMP
`);

// Called once per BUY/STRONG BUY token per participant per tick - cheap
// (bounded by BUY-tier count, never by the full 9300-token universe).
// entry_price_at_first_sight is only ever written on the FIRST sighting
// (the INSERT branch) - a re-sighting never overwrites it, so it stays
// a real "price when this candidate was first noticed" baseline.
function recordSighting({ runId, runParticipantId, tokenAddress, entryPrice }){
    upsertSightingStmt.run({ runId, runParticipantId, tokenAddress, entryPrice: entryPrice ?? null });
}

function findByParticipant(runParticipantId){
    return db.prepare(
        "SELECT * FROM benchmark_candidate_sightings WHERE run_participant_id = ?"
    ).all(runParticipantId);
}

module.exports = { recordSighting, findByParticipant };
