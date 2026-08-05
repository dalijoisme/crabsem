// repositories/decisionTimelineRepository.js - Sprint 15 (Scientific
// Decision Framework), Phase 5. The ONLY place that reads/writes
// decision_timeline_samples.
//
// DELIBERATE, STRUCTURAL: insert/find only, same as
// decisionEvidenceRepository.js and for the same reason - a flight
// recorder sample is a photograph of a real moment, never edited after
// the fact. No update, no delete, anywhere in this module.

const db = require("../database/connection");

const insertSampleStmt = db.prepare(`
    INSERT INTO decision_timeline_samples (
        decision_evidence_id, token_address,
        price, liquidity, holders, smart_degen_count,
        bundler_trader_amount_rate, fresh_wallet_rate, synthetic_score, momentum_phase
    ) VALUES (
        @decisionEvidenceId, @tokenAddress,
        @price, @liquidity, @holders, @smartDegenCount,
        @bundlerTraderAmountRate, @freshWalletRate, @syntheticScore, @momentumPhase
    )
`);

function insertSample(row){
    const info = insertSampleStmt.run({
        price: null, liquidity: null, holders: null, smartDegenCount: null,
        bundlerTraderAmountRate: null, freshWalletRate: null, syntheticScore: null, momentumPhase: null,
        ...row
    });
    return info.lastInsertRowid;
}

// The one real question this repository needs to answer to decide "is a
// sample due yet" (see decisionTimelineService.js) - the most recent
// sample_time for this decision, or null if none has ever been recorded.
function findMostRecentSampleTime(decisionEvidenceId){
    const row = db.prepare("SELECT sample_time FROM decision_timeline_samples WHERE decision_evidence_id = ? ORDER BY sample_time DESC, id DESC LIMIT 1").get(decisionEvidenceId);
    return row?.sample_time ?? null;
}

function findByDecisionId(decisionEvidenceId){
    return db.prepare("SELECT * FROM decision_timeline_samples WHERE decision_evidence_id = ? ORDER BY sample_time ASC, id ASC").all(decisionEvidenceId);
}

function countByDecisionId(decisionEvidenceId){
    return db.prepare("SELECT COUNT(*) c FROM decision_timeline_samples WHERE decision_evidence_id = ?").get(decisionEvidenceId).c;
}

module.exports = { insertSample, findMostRecentSampleTime, findByDecisionId, countByDecisionId };
