// repositories/benchmarkFunnelRepository.js - Profile-Aware Production
// V2 refactor, funnel visibility requirement. One row per participant
// per tick showing exactly where candidates were lost: tokens scanned
// -> hard reject -> AI candidate -> AI tier passed -> entry gate
// opened/skipped. Written by services/benchmarkRunner.js's tick(),
// read by services/benchmarkReportService.js for the report's `funnel`
// object.

const db = require("../database/connection");

const insertSnapshotStmt = db.prepare(`
    INSERT INTO benchmark_funnel_snapshots (
        run_id, run_participant_id, tokens_scanned, hard_reject_count,
        ai_candidates_count, ai_tier_passed_count,
        entry_gate_opened_count, entry_gate_skipped_count, skip_reasons_json, profile_aware
    ) VALUES (
        @runId, @runParticipantId, @tokensScanned, @hardRejectCount,
        @aiCandidatesCount, @aiTierPassedCount,
        @entryGateOpenedCount, @entryGateSkippedCount, @skipReasonsJson, @profileAware
    )
`);

function insertSnapshot({ runId, runParticipantId, tokensScanned, hardRejectCount, aiCandidatesCount, aiTierPassedCount, entryGateOpenedCount, entryGateSkippedCount, skipReasons, profileAware }){
    insertSnapshotStmt.run({
        runId, runParticipantId, tokensScanned,
        hardRejectCount: hardRejectCount ?? null,
        aiCandidatesCount: aiCandidatesCount ?? null,
        aiTierPassedCount: aiTierPassedCount ?? null,
        entryGateOpenedCount, entryGateSkippedCount,
        skipReasonsJson: skipReasons ? JSON.stringify(skipReasons) : null,
        profileAware: profileAware === false ? 0 : 1
    });
}

function findLatestForParticipant(runParticipantId){
    return db.prepare(
        "SELECT * FROM benchmark_funnel_snapshots WHERE run_participant_id = ? ORDER BY taken_at DESC, id DESC LIMIT 1"
    ).get(runParticipantId);
}

// Cumulative funnel across the whole run (sum of every tick's snapshot)
// - the shape the user's target funnel diagram actually describes
// ("9300 -> Hard Reject -> N Candidate -> AI Passed -> BUY" for the
// run as a whole, not just its most recent tick).
function sumForParticipant(runParticipantId){
    return db.prepare(`
        SELECT
            COUNT(*) as tickCount,
            COALESCE(SUM(tokens_scanned), 0) as tokensScanned,
            COALESCE(SUM(hard_reject_count), 0) as hardRejectCount,
            COALESCE(SUM(ai_candidates_count), 0) as aiCandidatesCount,
            COALESCE(SUM(ai_tier_passed_count), 0) as aiTierPassedCount,
            COALESCE(SUM(entry_gate_opened_count), 0) as entryGateOpenedCount,
            COALESCE(SUM(entry_gate_skipped_count), 0) as entryGateSkippedCount,
            MAX(profile_aware) as profileAware
        FROM benchmark_funnel_snapshots
        WHERE run_participant_id = ?
    `).get(runParticipantId);
}

module.exports = { insertSnapshot, findLatestForParticipant, sumForParticipant };
