// repositories/decisionCycleLogRepository.js - one row per scheduler
// cycle, real throughput analytics for the Admin Dashboard (see
// migration 018).

const db = require("../database/connection");

const insertStmt = db.prepare(`
    INSERT INTO decision_cycle_log (
        scanned, created, skipped, skip_reasons_json, avg_confidence,
        recommendation_changes, upgrades, downgrades,
        positions_opened, positions_closed_on_reversal, duration_ms
    ) VALUES (
        @scanned, @created, @skipped, @skipReasonsJson, @avgConfidence,
        @recommendationChanges, @upgrades, @downgrades,
        @positionsOpened, @positionsClosedOnReversal, @durationMs
    )
`);

function insertCycle(row){
    insertStmt.run(row);
}

// Real aggregate throughput over the last N hours - Predictions
// created/hour, skipped/hour, avg confidence, recommendation changes.
function summarizeSince(sinceIso){
    return db.prepare(`
        SELECT
            COALESCE(SUM(created), 0) as totalCreated,
            COALESCE(SUM(skipped), 0) as totalSkipped,
            COALESCE(SUM(scanned), 0) as totalScanned,
            COALESCE(SUM(recommendation_changes), 0) as totalRecommendationChanges,
            COALESCE(SUM(upgrades), 0) as totalUpgrades,
            COALESCE(SUM(downgrades), 0) as totalDowngrades,
            COALESCE(SUM(positions_opened), 0) as totalPositionsOpened,
            COALESCE(SUM(positions_closed_on_reversal), 0) as totalPositionsClosedOnReversal,
            AVG(avg_confidence) as avgConfidence,
            COUNT(*) as cycleCount
        FROM decision_cycle_log
        WHERE cycle_at >= ?
    `).get(sinceIso);
}

function findRecent(limit){
    return db.prepare("SELECT * FROM decision_cycle_log ORDER BY cycle_at DESC LIMIT ?").all(limit || 50);
}

// Aggregate skip reasons across recent cycles - real breakdown, not
// just a single cycle's snapshot.
function aggregateSkipReasonsSince(sinceIso){
    const rows = db.prepare("SELECT skip_reasons_json FROM decision_cycle_log WHERE cycle_at >= ? AND skip_reasons_json IS NOT NULL").all(sinceIso);
    const totals = {};
    for(const row of rows){
        try{
            const parsed = JSON.parse(row.skip_reasons_json);
            for(const [reason, count] of Object.entries(parsed)){
                totals[reason] = (totals[reason] || 0) + count;
            }
        } catch(e){ /* malformed row - skip, never guess */ }
    }
    return totals;
}

module.exports = { insertCycle, summarizeSince, findRecent, aggregateSkipReasonsSince };
