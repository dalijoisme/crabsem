// services/liveRecommendationService.js - Recommendation Lifecycle
// sprint. The ONE place that decides what recommendation a user
// actually SEES for a token, on the homepage, the token list, and the
// detail page alike - so the Decision Timeline (driven by
// predictionValidationService.js + the active production engine) and
// the homepage card can never again show two different answers for
// the same token (see PIPELINE_REDESIGN_HOMEPAGE_SYNC.md-equivalent
// notes below).
//
// Root causes this closes (see the redesign report for the full
// analysis):
//   1. tokenQueryService.js used to call intelligenceEngine.analyzeToken
//      directly - Production_V1, completely bypassing the Quality Gate
//      AND Production_V2/Momentum Hunter that the real decision
//      pipeline (predictionValidationService.js) already uses. A token
//      could pass the pipeline's quality gate check on one engine and
//      still show a rosy V1-computed action on the homepage.
//   2. Nothing measured "how long has this token gone WITHOUT a real
//      reconfirmation from the active engine" - a token whose data
//      collector kept refreshing it (so it never went ARCHIVED) but
//      whose real underlying condition had rotted (price crashed,
//      rug ratio spiked) could sit at the top of trending indefinitely,
//      because the action was recomputed fresh each time from
//      whatever the (unpenalized-enough) current numbers implied.
//   3. tokenStatusService already computes a real "Dumped"/"Dead"
//      label from real price-drawdown/age facts, but it was purely
//      decorative - never used to exclude a token from trending.
//
// Fix: read the SAME record that drives the Decision Timeline
// (token_last_decision, written every cycle by the active production
// engine), decay its confidence by real elapsed time since it was last
// reconfirmed, and hard-exclude on the same real Quality Gate plus the
// already-computed Dumped/Dead status. Nothing here is a new metric -
// every input was already being computed and stored somewhere; this
// module is the missing wiring between them.

const gmgnTrenchesRepository = require("../repositories/gmgnTrenchesRepository");
const tokenLastDecisionRepository = require("../repositories/tokenLastDecisionRepository");
const qualityGateService = require("./qualityGateService");
const confidenceDecayService = require("./confidenceDecayService");
const tokenStatusService = require("./tokenStatusService");
const intelligenceEngine = require("./intelligenceEngine");

const TIER_RANK = { "STRONG BUY": 4, "BUY": 3, "HOLD": 2, "WATCHLIST": 1, "REMOVE": 0, "AVOID": 0 };
const TIER_ORDER = ["REMOVE", "WATCHLIST", "HOLD", "BUY", "STRONG BUY"];

// CORRECTNESS NOTE (found during this sprint's own local validation,
// fixed before ever committing): config.actionTiers (strongBuy: 80,
// buy: 62, hold: 35) is calibrated for scoreToAction(participantScore)
// in intelligenceEngine.js - a DIFFERENT number, on a different scale,
// than `confidence` (a separately blended/penalized value - see
// computeConfidence()). Re-comparing a decayed CONFIDENCE against
// PARTICIPANT-SCORE thresholds produced real false downgrades: a token
// decided moments ago (decay fraction 1.0, i.e. zero real elapsed
// decay) with participantScore 100 -> STRONG BUY but confidence 75
// was wrongly remapped to BUY on the very first read, with no time
// having passed at all.
//
// Fix: never re-derive an absolute tier from a re-scaled number.
// Instead step DOWN the engine's own original tier, ordinally, by how
// much trust has decayed (the same 0..1 fraction already driving the
// confidence number) - a token's real original judgment erodes
// through its own ladder over time, it is never re-scored against a
// threshold table built for a different metric.
function stepDownByDecay(originalAction, fraction){

    if(originalAction === "AVOID") return "AVOID";

    const originalIndex = TIER_ORDER.indexOf(originalAction);
    const startIndex = originalIndex === -1 ? TIER_ORDER.indexOf("HOLD") : originalIndex;

    if(fraction === 0) return "REMOVE";

    // 0-60 min (fraction >= 0.90, see confidenceDecayService's curve):
    // barely decayed - tier unchanged, only the displayed confidence
    // number itself ticks down.
    if(fraction >= 0.90) return TIER_ORDER[startIndex];

    // ~1h-6h (fraction 0.50-0.90): one real step down the ladder,
    // floored at HOLD - matches "BUY -> HOLD" from the spec.
    if(fraction >= 0.50) return TIER_ORDER[Math.max(startIndex - 1, TIER_ORDER.indexOf("HOLD"))];

    // ~6h-24h (fraction 0-0.50): no longer trusted as an active
    // recommendation at any tier, but not yet fully expired either -
    // matches "-> WATCHLIST" from the spec.
    return "WATCHLIST";

}

// Real, already-computed hard-exclusion facts: the same Quality Gate
// the decision pipeline enforces, plus tokenStatusService's real
// price-drawdown/age-based Dumped/Dead label (previously decorative
// only). Never a new signal - just made enforceable.
function hardExclusionCheck(token){

    const quality = qualityGateService.passesQualityGate(token);
    if(!quality.pass) return { excluded: true, reason: quality.reason };

    const trenchesEntry = gmgnTrenchesRepository.findByTokenAddress(token.token_address);
    const marketAgeSeconds = intelligenceEngine.ageSecondsSince(token.updated_at);
    const lifecycle = intelligenceEngine.lifecycleForAge(marketAgeSeconds);
    const tokenStatus = tokenStatusService.computeTokenStatus({ token, trenchesEntry, lifecycle, marketAgeSeconds });

    if(tokenStatus === "Dumped") return { excluded: true, reason: "STATUS_DUMPED", tokenStatus };
    if(tokenStatus === "Dead") return { excluded: true, reason: "STATUS_DEAD", tokenStatus };

    return { excluded: false, reason: null, tokenStatus };

}

// Combines a token's real last decision (from the active production
// engine, via predictionValidationService.js) with elapsed-time decay
// and hard-exclusion facts into the ONE recommendation surfaced
// everywhere. `baseSignal` is intelligenceEngine's fresh computation -
// still used for its rich breakdown/reasons/intelligence sections
// (real, useful detail), but its action/confidence/risk are only used
// as a fallback when no decision-log entry exists yet for this token
// (a brand-new token the 60s pipeline cycle hasn't reached yet - a
// gap of at most one cycle, not a fabricated placeholder).
function resolveLiveRecommendation(token, baseSignal){

    const hard = hardExclusionCheck(token);

    if(hard.excluded){

        return {
            action: "AVOID",
            confidence: 0,
            risk: "HIGH",
            excludeFromTrending: true,
            exclusionReason: hard.reason,
            hasDecision: false,
            decayFraction: 0,
            evolutionStage: "REMOVED",
            tokenStatus: hard.tokenStatus ?? null
        };

    }

    const last = tokenLastDecisionRepository.findByToken(token.token_address);

    if(!last){

        // No decision-log entry yet (brand-new token, pipeline hasn't
        // reached it in its first 60s cycle) - show V1's fresh read as
        // a real, honest value, just flagged as not-yet-reconciled.
        return {
            action: baseSignal.action,
            confidence: baseSignal.confidence,
            risk: baseSignal.risk,
            excludeFromTrending: false,
            exclusionReason: null,
            hasDecision: false,
            decayFraction: 1,
            evolutionStage: baseSignal.action,
            tokenStatus: hard.tokenStatus
        };

    }

    const fraction = confidenceDecayService.decayFraction(confidenceDecayService.minutesSince(last.last_decision_at));
    const decayedConfidence = confidenceDecayService.applyDecay(last.last_confidence, last.last_decision_at);

    const finalAction = stepDownByDecay(last.last_recommendation, fraction);

    const excludeFromTrending = finalAction === "REMOVE" || finalAction === "AVOID";

    return {
        action: finalAction === "REMOVE" ? "AVOID" : finalAction,
        confidence: decayedConfidence,
        risk: last.last_risk || baseSignal.risk,
        excludeFromTrending,
        exclusionReason: excludeFromTrending ? (finalAction === "REMOVE" ? "FULLY_DECAYED" : "AVOID") : null,
        hasDecision: true,
        decayFraction: fraction,
        evolutionStage: finalAction,
        lastDecisionAt: last.last_decision_at,
        originalRecommendation: last.last_recommendation,
        originalConfidence: last.last_confidence,
        tokenStatus: hard.tokenStatus
    };

}

module.exports = { resolveLiveRecommendation, stepDownByDecay, TIER_RANK };
