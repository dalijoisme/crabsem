// services/decisionEvidenceService.js - Sprint 15 (Scientific Decision
// Framework), Phase 3/4. Assembles and persists Decision Evidence for a
// real BUY - the frozen Foundation Tier + Derived Tier + Config Snapshot
// + (Phase 4) Candidate Snapshot behind that exact decision.
//
// SAFETY INVARIANT: capture must NEVER be able to block, delay, or alter
// a real BUY. captureDecisionEvidence below never throws past its own
// boundary (try/catch, log-and-swallow) - a bug here can cost an audit
// trail, never a trade. tradeManager.js calls this AFTER a real position
// row is already inserted, for the same reason.
//
// SCOPE (corrected after Batch 1's own self-review): Foundation Tier
// covers the real token row, real trenches row, this token's real peak
// price, and its real realtime pulse snapshot - all four already reach
// tradeManager.js's openPosition today (peak via
// live.momentumPhaseFacts.peak, realtimePulse via
// live.breakdown.realtimePulse - both real values researchEngineFactory.js
// already carries all the way through, verified by rereading its actual
// source rather than assumed). Still genuinely missing: the raw activity
// feed rows (smart money/KOL trades) actually used, wallet stats used,
// the on-demand security cache body used, and the raw liquidity-at-
// window-start value (only its DERIVED accel score survives onto
// `live`, not the raw number) - these are consumed upstream inside
// analyzeTokenWithPhilosophy and never surfaced past it. See
// contextContract.js's PLANNED_CONTEXT_ADDITIONS and
// FOUNDATION_TIER_REQUIRED_SOURCES below - closing this gap is an
// explicit objective of Phase 6 (Replay Context Builder), not decided
// here.

const crypto = require("crypto");
const decisionEvidenceRepository = require("../repositories/decisionEvidenceRepository");
const scoringConfig = require("../config/scoringConfig");
const syntheticMarketFilterConfig = require("../config/syntheticMarketFilterConfig");
const contextContract = require("./contextContract");

const DECISION_EVIDENCE_SCHEMA_VERSION = 1;

// Real, first, reasonable bound - same "unvalidated starting point, not
// final" convention this codebase already uses for a brand-new threshold
// (e.g. entryGateService.js's MAX_MARKET_DATA_AGE_SECONDS,
// qualityGateService.js's QUALITY_GATE). Caps Candidate Snapshot's
// storage cost to a small constant multiple of one decision's own cost,
// regardless of how large a real candidate pool gets on a busy tick -
// see the Sprint 15 architecture review's own validated cost/value
// tradeoff. Revisit once real Decision Diff usage shows whether more/
// fewer alternatives are actually useful.
const CANDIDATE_SNAPSHOT_TOP_N = 10;

function hashConfig(configObject){
    const json = JSON.stringify(configObject);
    const hash = crypto.createHash("sha256").update(json).digest("hex");
    return { hash, json };
}

// The GLOBAL, shared scoring config actually in effect right now -
// deduplicated across every decision via its content hash (see
// decisionEvidenceRepository.insertConfigSnapshotIfAbsent). Deliberately
// scoped to the config files that actually shape a BUY decision - not
// every file under config/ (e.g. retentionConfig.js/
// predictionValidationConfig.js govern unrelated subsystems and would
// only add noise here).
function buildGlobalConfigSnapshot(){
    return {
        scoringConfig,
        syntheticMarketFilterConfig
    };
}

function persistConfigSnapshot(){
    const { hash, json } = hashConfig(buildGlobalConfigSnapshot());
    decisionEvidenceRepository.insertConfigSnapshotIfAbsent(hash, json);
    return hash;
}

// The canonical, complete set of raw sources a fully-faithful replay of
// ANY future scoring algorithm would need (see this file's own header).
// Order is not significant - used only to compute which are present.
const FOUNDATION_TIER_REQUIRED_SOURCES = [
    "token", "trenches", "peak", "realtimePulse",
    "activityFeed", "walletStats", "securityCache", "liquidityAtWindowStart"
];

// Foundation Tier - verbatim, real payloads only (never a curated field
// subset - see this file's own header, and contextContract.js's guiding
// principle: a future algorithm may need a field nothing today reads).
// extras carries whichever of the still-missing sources a future caller
// can supply (Phase 6 onward) - every key optional, absent ones simply
// don't count toward completeness below.
function buildFoundationTier(token, trenchesEntry, extras = {}){
    const tier = {
        token: token ?? null,
        trenches: trenchesEntry ?? null,
        peak: extras.peak ?? null,
        realtimePulse: extras.realtimePulse ?? null,
        activityFeed: extras.activityFeed ?? null,
        walletStats: extras.walletStats ?? null,
        securityCache: extras.securityCache ?? null,
        liquidityAtWindowStart: extras.liquidityAtWindowStart ?? null
    };
    const missingRawSources = FOUNDATION_TIER_REQUIRED_SOURCES.filter(key => tier[key] == null);
    return { tier: { ...tier, _missingRawSources: missingRawSources }, missingRawSources };
}

// COMPLETE only once every canonical source in FOUNDATION_TIER_REQUIRED_SOURCES
// is present - lets future replay tooling filter on this one real column
// (decision_evidence.foundation_tier_completeness) instead of inspecting
// foundation_tier_json's own contents field by field.
function computeFoundationTierCompleteness(missingRawSources){
    return missingRawSources.length === 0 ? "COMPLETE" : "PARTIAL_FOUNDATION";
}

// Derived Tier - every real, already-computed field `live` carries by
// the time openPosition() runs, plus the entry-time observability fields
// tradeManager.js itself already computes (tokenAgeMinutesAtEntry/
// rawFactsAtEntry/passReason) - reused verbatim, never recomputed a
// second time.
function buildDerivedTier(live, extras = {}){
    return {
        action: live.action ?? null,
        confidence: live.confidence ?? null,
        baseConfidence: live.baseConfidence ?? null,
        risk: live.risk ?? null,
        participantScore: live.participantScore ?? null,
        participantMax: live.participantMax ?? null,
        marketHealth: live.marketHealth ?? null,
        marketHealthMax: live.marketHealthMax ?? null,
        breakdown: live.breakdown ?? null,
        reasons: live.reasons ?? [],
        riskReasons: live.riskReasons ?? [],
        missingEvidence: live.missingEvidence ?? [],
        confidenceBreakdown: live.confidenceBreakdown ?? null,
        realtimeConfidenceAdjustment: live.realtimeConfidenceAdjustment ?? null,
        acceleration: live.acceleration ?? null,
        momentumPhase: live.momentumPhase ?? null,
        momentumPhaseFacts: live.momentumPhaseFacts ?? null,
        freshnessPenalty: live.freshnessPenalty ?? null,
        entryGateResult: live.entryGateResult ?? null,
        qualityGateResult: live.qualityGateResult ?? null,
        rankAtEntry: live.rankAtEntry ?? null,
        priorityScoreAtEntry: live.priorityScoreAtEntry ?? null,
        ...extras
    };
}

// Phase 4 (Candidate Snapshot) - Top-N other real ranked BUY-tier
// candidates this exact cycle, derived-tier depth only. Validated
// tradeoff (Sprint 15 architecture review): full Foundation Tier for the
// whole candidate pool would multiply write cost ~100-300x per BUY on a
// busy tick; derived-tier-only for non-winners answers "was the winner
// ranked correctly by the engine that actually ran" without that cost -
// it does NOT support replaying a future engine against a non-winner, a
// documented, accepted limitation, not an oversight. Returns null (never
// an empty array masquerading as "checked, found nothing") when there
// were genuinely no other candidates this cycle.
function buildCandidateSnapshot(siblings){
    if(!siblings?.length) return null;
    return siblings.slice(0, CANDIDATE_SNAPSHOT_TOP_N).map(s => ({
        tokenAddress: s.tokenAddress,
        tokenSymbol: s.tokenSymbol ?? null,
        rank: s.rank ?? null,
        priorityScore: s.priorityScore ?? null,
        action: s.action ?? null,
        confidence: s.confidence ?? null,
        risk: s.risk ?? null,
        participantScore: s.participantScore ?? null,
        marketHealth: s.marketHealth ?? null,
        breakdown: s.breakdown ?? null
    }));
}

// The single entry point tradeManager.js calls, right after a real
// position row is successfully inserted. Never throws past this
// boundary - a capture failure is logged and swallowed, exactly the
// "capture must never block a real BUY" invariant this file's own header
// states. Returns the new decision_evidence row id, or null if capture
// failed.
//
// siblings (Phase 4, optional): this exact cycle's other real ranked
// BUY-tier candidates, already shaped as { tokenAddress, tokenSymbol,
// rank, priorityScore, action, confidence, risk, participantScore,
// marketHealth, breakdown } by the caller (tradingBotEngine.js) - never
// re-derived here.
function captureDecisionEvidence({
    token, trenchesEntry, live, config, riskBands,
    userId, engineVersion, positionId,
    tokenAgeMinutesAtEntry, rawFactsAtEntry, passReason,
    siblings, origin
}){
    try{

        const configHash = persistConfigSnapshot();
        const candidateSnapshot = buildCandidateSnapshot(siblings);

        // peak/realtimePulse: real values already carried all the way
        // through onto `live` by researchEngineFactory.js - see this
        // file's own header for exactly where each one comes from.
        // activityFeed/walletStats/securityCache/liquidityAtWindowStart
        // remain genuinely unavailable here today (Phase 6's objective).
        const { tier: foundationTier, missingRawSources } = buildFoundationTier(token, trenchesEntry, {
            peak: live?.momentumPhaseFacts?.peak ?? null,
            realtimePulse: live?.breakdown?.realtimePulse ?? null
        });

        const row = {
            tokenAddress: token.token_address,
            tokenSymbol: token.symbol ?? null,
            userId: userId ?? null,
            engineVersion: engineVersion ?? null,
            strategyProfile: config?.strategy_profile ?? null,
            origin: origin || "REAL_BUY",

            action: live.action ?? null,
            confidence: live.confidence ?? null,
            risk: live.risk ?? null,
            participantScore: live.participantScore ?? null,
            marketHealth: live.marketHealth ?? null,

            decisionEvidenceSchemaVersion: DECISION_EVIDENCE_SCHEMA_VERSION,
            contextSchemaVersion: contextContract.CONTEXT_SCHEMA_VERSION,
            foundationTierCompleteness: computeFoundationTierCompleteness(missingRawSources),

            foundationTierJson: JSON.stringify(foundationTier),
            derivedTierJson: JSON.stringify(buildDerivedTier(live, {
                tokenAgeMinutesAtEntry: tokenAgeMinutesAtEntry ?? null,
                rawFactsAtEntry: rawFactsAtEntry ?? null,
                passReason: passReason ?? null
            })),

            configHash,
            perUserConfigJson: config ? JSON.stringify(config) : null,
            tradePlanJson: riskBands ? JSON.stringify(riskBands) : null,
            candidateSnapshotJson: candidateSnapshot ? JSON.stringify(candidateSnapshot) : null,

            linkedPositionId: positionId ?? null,
            linkedTradeId: null // filled in by a later step once/if the position closes - never guessed here
        };

        return decisionEvidenceRepository.insertDecisionEvidence(row);

    }
    catch(err){
        // Deliberate: never let a capture bug touch the real BUY it's
        // describing. console.error only - no rethrow, ever.
        console.error(`[decision-evidence] capture failed for token=${token?.symbol || token?.token_address}: ${err.message}`, err);
        return null;
    }
}

module.exports = {
    captureDecisionEvidence,
    DECISION_EVIDENCE_SCHEMA_VERSION,
    CANDIDATE_SNAPSHOT_TOP_N,
    FOUNDATION_TIER_REQUIRED_SOURCES,
    // exported for tests only - internal assembly helpers.
    buildFoundationTier, buildDerivedTier, buildCandidateSnapshot, buildGlobalConfigSnapshot, hashConfig,
    computeFoundationTierCompleteness
};
