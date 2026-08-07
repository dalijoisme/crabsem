// repositories/tokenDecisionSnapshotRepository.js - the only place that
// reads/writes token_decision_snapshots (migration 074). Same
// append-only, eventually-pruned shape as realtimePulseRepository.js -
// see that file's own header and migration 074's header for the full
// rationale (decision-side time series, complementing
// realtime_pulse_snapshots' market/flow-side time series).

const db = require("../database/connection");

const insertStmt = db.prepare(`
    INSERT INTO token_decision_snapshots (
        token_address, recommendation, confidence, base_confidence,
        participant_score, market_health, risk, momentum_phase, module_scores_json
    ) VALUES (
        @tokenAddress, @recommendation, @confidence, @baseConfidence,
        @participantScore, @marketHealth, @risk, @momentumPhase, @moduleScoresJson
    )
`);

function insertSnapshot(entry){

    return insertStmt.run({
        tokenAddress: entry.tokenAddress,
        recommendation: entry.recommendation ?? null,
        confidence: entry.confidence ?? null,
        baseConfidence: entry.baseConfidence ?? null,
        participantScore: entry.participantScore ?? null,
        marketHealth: entry.marketHealth ?? null,
        risk: entry.risk ?? null,
        momentumPhase: entry.momentumPhase ?? null,
        moduleScoresJson: entry.moduleScores ? JSON.stringify(entry.moduleScores) : null
    });

}

// The full real history for one token, oldest first - what a "confidence/
// participant/momentum evolution in the minutes before BUY" comparison
// reads.
function findForToken(tokenAddress, { sinceIso = null } = {}){

    if(sinceIso){
        return db.prepare(`
            SELECT * FROM token_decision_snapshots
            WHERE token_address = ? AND recorded_at >= ?
            ORDER BY recorded_at ASC, id ASC
        `).all(tokenAddress, sinceIso);
    }

    return db.prepare(`
        SELECT * FROM token_decision_snapshots
        WHERE token_address = ?
        ORDER BY recorded_at ASC, id ASC
    `).all(tokenAddress);

}

function countAll(){
    return db.prepare("SELECT COUNT(*) as n FROM token_decision_snapshots").get().n;
}

// Same batched, event-loop-yielding shape as realtimePulseRepository.js's
// own pruneOlderThan - see that file's header for the real production
// incident (unbatched pruning blocking the event loop for minutes) this
// convention exists to avoid repeating.
const PRUNE_BATCH_SIZE = 200;

function yieldToEventLoop(){
    return new Promise(resolve => setImmediate(resolve));
}

const pruneOlderThanBatchStmt = db.prepare(`
    DELETE FROM token_decision_snapshots WHERE id IN (
        SELECT id FROM token_decision_snapshots WHERE recorded_at < @cutoff LIMIT @batch
    )
`);

async function pruneOlderThan(maxAgeHours){

    const cutoff = new Date(Date.now() - maxAgeHours * 3600000).toISOString().slice(0, 19).replace("T", " ");

    let total = 0;

    while(true){

        const info = pruneOlderThanBatchStmt.run({ cutoff, batch: PRUNE_BATCH_SIZE });
        total += info.changes;

        if(info.changes < PRUNE_BATCH_SIZE) break;

        await yieldToEventLoop();

    }

    return total;

}

module.exports = { insertSnapshot, findForToken, countAll, pruneOlderThan };
