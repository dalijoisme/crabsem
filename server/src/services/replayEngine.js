// services/replayEngine.js - Sprint 15 (Scientific Decision Framework),
// Phase 7. The engine that actually replays a real, historical BUY
// decision - and the direct proof of the approved architecture's central
// promise: "Replay must execute Production Scoring Functions without
// modification. Replay and LIVE differ only by Context Builder."
//
// This file contains NO scoring logic of its own, anywhere. Every real
// number a replay produces comes from calling
// researchEngineFactory.analyzeTokensWithOverride - the exact same
// function every live BUY decision is scored by - fed a ctx built by
// replayContextBuilder.buildReplayContext instead of
// researchEngineFactory.preloadContext. That is the entire mechanism.
//
// REPLAY PURITY: this file never calls a repository, never calls
// collector code, never calls orchestration functions
// (entryGateService.evaluateEntry, tradingBotEngine.runCycle). It only
// reads an already-captured decision_evidence row and calls the real
// scoring function - see replayContextBuilder.js's own header for the
// same invariant, one layer down.

const researchEngineFactory = require("./researchEngineFactory");
const { buildReplayContext } = require("./replayContextBuilder");
const decisionEvidenceRepository = require("../repositories/decisionEvidenceRepository");

// baseKey: which named philosophy (researchEngineFactory.PHILOSOPHIES) to
// replay through - defaults to "momentumHunter" (production_v2, the only
// philosophy any real decision_evidence row has ever been scored under -
// see config/productionVersionRegistry.js). override: an optional
// partial philosophy override (weights/tiers/acceleration/etc, same
// shape analyzeTokensWithOverride already accepts) - this is THE lever
// Decision Diff (Phase 8) uses to ask "what would a DIFFERENT engine
// have said about this exact frozen evidence."
const DEFAULT_BASE_PHILOSOPHY_KEY = "momentumHunter";

// Replays one real, already-captured decision. Returns null (never
// throws) if the record doesn't exist or its Foundation Tier has no real
// token to replay - a genuinely unreplayable record is a fact to report,
// not an exception to propagate.
function replayDecision(decisionEvidenceId, { baseKey = DEFAULT_BASE_PHILOSOPHY_KEY, override = null } = {}){

    const record = decisionEvidenceRepository.findById(decisionEvidenceId);
    if(!record) return null;

    const { ctx, token, foundationTierCompleteness, missingRawSources } = buildReplayContext(record);
    if(!token) return null; // Foundation Tier never captured a real token for this record - nothing to replay

    const [replayedSignal] = researchEngineFactory.analyzeTokensWithOverride([token], ctx, baseKey, override);

    return {
        decisionEvidenceId,
        record,
        baseKey,
        override,
        foundationTierCompleteness,
        missingRawSources,
        originalAction: record.action,
        originalConfidence: record.confidence,
        originalParticipantScore: record.participant_score,
        replayedSignal
    };

}

// Replays many decisions through the SAME engine/override - each
// decision is independent (no shared state between them, per-decision
// ctx built fresh every time), so this is a plain, embarrassingly-
// parallel loop, not anything requiring real concurrency given
// better-sqlite3's synchronous reads. Skips (never throws for) any id
// that fails to replay - callers get a shorter array back, not a crash
// mid-batch over one bad historical record.
function replayMany(decisionEvidenceIds, options = {}){
    const results = [];
    for(const id of decisionEvidenceIds){
        const result = replayDecision(id, options);
        if(result) results.push(result);
    }
    return results;
}

module.exports = { replayDecision, replayMany, DEFAULT_BASE_PHILOSOPHY_KEY };
